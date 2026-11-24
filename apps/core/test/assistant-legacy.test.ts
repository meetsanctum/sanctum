import {
  aiAssistantPermission,
  assistantAppId,
  assistantRequestSchema,
  defineApp,
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

import { base, cleanUps, running, useCleanUps } from "./app-apart-support.js";
import { claimed, post, testCore } from "./support.js";

useCleanUps();

it("keeps a protocol 21 Assistant connected across a takeover", async () => {
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
  const protocol = 21;
  const manifest = { ...toStaticManifest(app), protocol };
  const digest = manifestDigest(JSON.stringify(manifest));
  const folder = await mkdtemp(join(tmpdir(), "sanctum-apart-"));
  cleanUps.push(() => rm(folder, { recursive: true, force: true }));
  const core = await testCore({
    appSockets: folder,
    apart: [
      { apart: { manifest, digest, folder: "1.0.0+test" }, origin: "official" },
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
  const legacyRequestSchema = assistantRequestSchema.omit({ earlier: true });

  const first = ask("First");
  await vi.waitFor(() => expect(requests()).toHaveLength(1));
  const second = ask("Second");
  await vi.waitFor(() => expect(requests()).toHaveLength(2));
  const [older, newer] = requests();
  if (older?.body.kind !== "request" || newer?.body.kind !== "request") {
    throw new Error("Expected two Assistant requests");
  }
  expect(legacyRequestSchema.parse(older.body.request).text).toBe("First");
  expect(legacyRequestSchema.parse(newer.body.request).text).toBe("Second");
  expect((await first).json()).toEqual({ reply: null });

  say({
    type: "request",
    id: 1,
    call: older.id,
    method: "aiTools",
    params: [],
  });
  say({
    type: "request",
    id: 2,
    call: newer.id,
    method: "replyRequest",
    params: [{ text: "Here." }],
  });
  expect((await second).json()).toEqual({ reply: "Here." });
  await vi.waitFor(() =>
    expect(heard).toContainEqual({
      type: "reply",
      id: 1,
      outcome: { ok: false, message: "turn_ended" },
    }),
  );
  expect(heard.some((message) => message.type === "end")).toBe(false);
  expect(socket.destroyed).toBe(false);
  say({ type: "answer", call: older.id, outcome: { ok: true } });
  say({ type: "answer", call: newer.id, outcome: { ok: true } });
});
