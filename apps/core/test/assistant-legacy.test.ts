import {
  aiAssistantPermission,
  assistantAppId,
  defineApp,
  earlierExchangeSchema,
  requestLanguages,
  toStaticManifest,
} from "@meetsanctum/app-sdk";
import { manifestDigest } from "@meetsanctum/app-sdk/package";
import {
  coreSocketName,
  createMessageReader,
  encodeMessage,
  type CoreMessage,
} from "@meetsanctum/app-sdk/protocol";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import { base, cleanUps, running, useCleanUps } from "./app-apart-support.js";
import { claimed, post, testCore } from "./support.js";

useCleanUps();

it.each([21, 25])(
  "keeps a protocol %i Assistant connected across a takeover",
  checkTakeover,
);

async function checkTakeover(protocol: number) {
  const app = defineApp({
    ...base,
    id: assistantAppId,
    name: "Assistant",
    permissions: [
      {
        id: aiAssistantPermission,
        needed: true,
        reason: "To answer requests.",
      },
    ],
    actions: [],
    async requests() {},
  });
  const manifest = { ...toStaticManifest(app), protocol };
  const digest = manifestDigest(JSON.stringify(manifest));
  const folder = await mkdtemp(join(tmpdir(), "sanctum-apart-"));
  cleanUps.push(() => rm(folder, { recursive: true, force: true }));
  const core = await testCore({
    appSockets: folder,
    apart: [
      {
        apart: { manifest, digest, folder: "1.0.0+test" },
        origin: "official",
      },
    ],
  });
  cleanUps.push(() => core.apps.close());
  const maya = await claimed(core);
  const socket = createConnection(join(folder, assistantAppId, coreSocketName));
  cleanUps.push(async () => {
    socket.destroy();
  });
  const heard: CoreMessage[] = [];
  const say = (message: Parameters<typeof encodeMessage>[0]) =>
    socket.write(encodeMessage(message));
  socket.on(
    "data",
    createMessageReader({
      message(value) {
        // This fixture checks the legacy request and reply shapes below.
        const message = value as CoreMessage;
        heard.push(message);
        if (message.type === "ping") say({ type: "pong", beat: message.beat });
        if (message.type === "call" && message.body.kind === "start") {
          say({ type: "answer", call: message.id, outcome: { ok: true } });
        }
      },
      violation: (reason) => socket.destroy(new Error(reason)),
    }),
  );
  await once(socket, "connect");
  say({
    type: "hello",
    protocol,
    app: assistantAppId,
    version: app.version,
    manifest: digest,
  });
  await vi.waitFor(() =>
    expect(heard).toContainEqual(expect.objectContaining({ type: "welcome" })),
  );
  say({ type: "ready" });
  await running(core, assistantAppId);

  const ask = (text: string) =>
    post(core, "/api/assistant/ask", { text }, { token: maya.token });
  const requests = () =>
    heard
      .filter((message) => message.type === "call")
      .filter((message) => message.body.kind === "request");
  // Both runners take the client's name. Protocol 25 also takes history.
  const legacy = z.strictObject({
    text: z.string(),
    language: z.enum(requestLanguages),
    clientName: z.string().min(1),
  });
  const legacyRequestSchema =
    protocol === 21
      ? legacy
      : legacy.extend({ earlier: z.array(earlierExchangeSchema) });

  const first = ask("First");
  await vi.waitFor(() => expect(requests()).toHaveLength(1));
  const second = ask("Second");
  await vi.waitFor(() => expect(requests()).toHaveLength(2));
  const [older, newer] = requests();
  if (older?.body.kind !== "request" || newer?.body.kind !== "request") {
    throw new Error("Expected two Assistant requests");
  }
  const firstRequest = legacyRequestSchema.parse(older.body.request);
  const secondRequest = legacyRequestSchema.parse(newer.body.request);
  expect(firstRequest.text).toBe("First");
  expect(secondRequest.text).toBe("Second");
  expect(secondRequest.clientName).toBe(firstRequest.clientName);
  if (protocol === 25) {
    expect(firstRequest).toMatchObject({ earlier: [] });
    expect(secondRequest).toMatchObject({
      earlier: [{ asked: "First", reply: null, cutOff: true }],
    });
  }
  expect((await first).json()).toEqual({ reply: null });

  say({
    type: "request",
    id: 1,
    call: older.id,
    method: "aiTools",
    params: [],
  });
  // A confirmation is an app's from protocol 26 on.
  say({
    type: "request",
    id: 3,
    call: newer.id,
    method: "replyRequest",
    params: [{ text: "Here.", confirmation: true }],
  });
  await vi.waitFor(() =>
    expect(heard).toContainEqual({
      type: "reply",
      id: 3,
      outcome: expect.objectContaining({ ok: false }),
    }),
  );
  say({
    type: "request",
    id: 2,
    call: newer.id,
    method: "replyRequest",
    params: [{ text: "Here." }],
  });
  expect((await second).json()).toEqual({ reply: "Here." });
  // A runner from 22 is told its older call ended; one before runs it out,
  // its later calls refused.
  if (protocol === 25) {
    expect(heard).toContainEqual(
      expect.objectContaining({ type: "end", call: older.id }),
    );
  } else {
    await vi.waitFor(() =>
      expect(heard).toContainEqual({
        type: "reply",
        id: 1,
        outcome: { ok: false, message: "turn_ended" },
      }),
    );
    expect(heard.some((message) => message.type === "end")).toBe(false);
  }
  expect(socket.destroyed).toBe(false);
  say({ type: "answer", call: older.id, outcome: { ok: true } });
  say({ type: "answer", call: newer.id, outcome: { ok: true } });
}
