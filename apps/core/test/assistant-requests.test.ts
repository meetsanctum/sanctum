import {
  aiAssistantPermission,
  assistantAppId,
  defineApp,
  modelsUsePermission,
  toStaticManifest,
  type AppDefinition,
  type AssistantRequestCall,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { contractOf } from "../src/app-host/contract.js";
import { apart, base, running, useCleanUps } from "./app-apart-support.js";
import {
  claimed,
  deferredDelivery,
  deferredResult,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// A request is what someone types to Sanctum: the core opens a turn for it
// and runs Sanctum's Assistant's handler, which answers with request.reply.
// Only that app may answer requests, and with none to answer the core says
// so at once.

useCleanUps();

type Handler = (
  ctx: Parameters<NonNullable<AppDefinition["requests"]>>[0],
  request: AssistantRequestCall,
) => Promise<void>;

function assistant(
  handler: Handler,
  { id = assistantAppId, needed = true } = {},
) {
  return defineApp({
    ...base,
    id,
    name: "Assistant",
    permissions: [
      {
        id: aiAssistantPermission,
        reason: "To do what you ask.",
        needed,
      },
      { id: modelsUsePermission, reason: "To answer you.", needed: false },
    ],
    actions: [],
    requests: handler,
  });
}

// Says what it was asked, from where, and how many rooms the home has.
const echo: Handler = async (ctx, request) => {
  const tools = await ctx.ai.list();
  const overview = await ctx.ai.call("home_overview");
  const rooms = (JSON.parse(overview.text) as { rooms: unknown[] }).rooms;
  await request.reply({
    text: `"${request.text}" from ${request.from.kind} ${request.from.name} in ${request.room?.name ?? "no room"} (${request.language}), ${tools.length > 0 ? "with tools" : "without"}, ${rooms.length} rooms`,
  });
};

async function ask(core: TestCore, token: string, body: unknown) {
  return post(core, "/api/assistant/ask", body, { token });
}

async function inCore(handler: Handler) {
  const core = await testCore({
    apps: [{ app: assistant(handler), origin: "official" }],
  });
  const maya = await claimed(core);
  return { core, maya };
}

describe("a typed request", () => {
  it("reaches Sanctum's Assistant, which answers within a turn for whoever asked", async () => {
    const { core, maya } = await inCore(echo);

    const asked = await ask(core, maya.token, { text: "  Is it raining?  " });

    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toEqual({
      reply:
        '"Is it raining?" from client Maya\'s MacBook in no room (en), with tools, 0 rooms',
    });
  });

  it("answers as soon as the Assistant replies, while it goes on", async () => {
    const release = deferredDelivery();
    const answered = deferredResult<unknown>();
    const { core, maya } = await inCore(async (ctx, request) => {
      await request.reply({ text: "On it." });
      await release.promise;
      try {
        const text = await ctx.models
          .answer({ messages: [{ role: "user", content: request.text }] })
          .text();
        answered.resolve(text);
      } catch (error) {
        answered.resolve(error);
      }
    });

    try {
      const asked = await ask(core, maya.token, { text: "Tidy up" });
      expect(asked.json()).toEqual({ reply: "On it." });
      release.resolve();
      // With no model configured, the open turn returns an empty answer.
      expect(await answered.promise).toBe("");
    } finally {
      release.resolve();
    }
  });

  it("is answered once, and with nothing when the Assistant gives no reply", async () => {
    const replies: string[] = [];
    const { core, maya } = await inCore(async (_ctx, request) => {
      if (request.text === "quiet") return;
      await request.reply({ text: "First." });
      try {
        await request.reply({ text: "Second." });
      } catch {
        replies.push("refused");
      }
    });

    expect((await ask(core, maya.token, { text: "twice" })).json()).toEqual({
      reply: "First.",
    });
    await vi.waitFor(() => expect(replies).toEqual(["refused"]));
    expect((await ask(core, maya.token, { text: "quiet" })).json()).toEqual({
      reply: null,
    });
  });

  it("says the Assistant is off when there's none to answer", async () => {
    const core = await testCore();
    const maya = await claimed(core);

    const asked = await ask(core, maya.token, { text: "Hello?" });

    expect(asked.statusCode).toBe(503);
  });

  it("refuses a request when the running Assistant lacks the grant", async () => {
    const handler = vi.fn(echo);
    const core = await testCore({
      apps: [
        { app: assistant(handler, { needed: false }), origin: "official" },
      ],
      allowed: false,
    });
    const maya = await claimed(core);
    await running(core, assistantAppId);

    const asked = await ask(core, maya.token, { text: "Hello?" });

    expect(asked.statusCode).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs a shared device's request as that client", async () => {
    const { core } = await inCore(async (ctx, request) => {
      await request.reply({ text: `${ctx.actor.kind}:${ctx.actor.id}` });
    });
    const client = sharedClient(core);

    const asked = await ask(core, client.token, { text: "Hello" });

    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toEqual({ reply: `client:${client.id}` });
  });

  it("comes only from a person or a shared device, in words", async () => {
    const { core, maya } = await inCore(echo);
    const agent = core.auth.clients.createAgent({
      name: "Codex on the office Mac",
      platform: "macos",
      addedBy: { kind: "person", id: maya.person.id },
    });

    expect((await ask(core, agent.token, { text: "Hi" })).statusCode).toBe(403);
    expect((await ask(core, maya.token, { text: "   " })).statusCode).toBe(400);
    expect(
      (await ask(core, maya.token, { text: "Hi", language: "fr" })).statusCode,
    ).toBe(400);
  });
});

describe("who answers requests", () => {
  it("is Sanctum's Assistant alone: any other app's handler is refused", () => {
    const other = assistant(echo, { id: "sanctum.example" });

    expect(() => contractOf(toStaticManifest(other))).toThrow(
      "Only Sanctum's Assistant answers requests",
    );
    expect(() => contractOf(toStaticManifest(assistant(echo)))).not.toThrow();
  });

  it("takes sentences for smart speakers from the Assistant alone, within what can be learned", () => {
    const manifest = {
      ...toStaticManifest(assistant(echo)),
      sentences: { en: ["turn (on|off) the {room} lights"] },
    };
    expect(() => contractOf(manifest)).not.toThrow();
    expect(() =>
      contractOf({ ...manifest, id: "sanctum.example", requests: undefined }),
    ).toThrow("Only Sanctum's Assistant brings sentences");
    expect(() =>
      contractOf({ ...manifest, sentences: { en: ["dim the {zone}"] } }),
    ).toThrow("{zone}");
    expect(() =>
      contractOf({
        ...manifest,
        sentences: {
          en: Array(40).fill("turn on [the] {light} and [the] {light}"),
        },
      }),
    ).toThrow("steps to learn in a large home");
    // What speech it doesn't know gets, in its sentences' languages only.
    const notUnderstood = { en: "I can only help with lights and moods" };
    expect(() => contractOf({ ...manifest, notUnderstood })).not.toThrow();
    expect(() =>
      contractOf({ ...manifest, notUnderstood: { de: "Nur Licht" } }),
    ).toThrow("has no de sentences");
    expect(() =>
      contractOf({
        ...manifest,
        id: "sanctum.example",
        requests: undefined,
        sentences: undefined,
        notUnderstood,
      }),
    ).toThrow("Only Sanctum's Assistant says what it didn't understand");
  });

  it("requires the Assistant to declare the grant for answering requests", () => {
    const manifest = toStaticManifest(assistant(echo));
    expect(() => contractOf({ ...manifest, permissions: [] })).toThrow(
      aiAssistantPermission,
    );
  });

  it("accepts a kept Assistant package with bare optional choices", () => {
    const manifest = {
      ...toStaticManifest(assistant(echo)),
      sentences: { en: ["undo [that|it]"] },
    };
    expect(() => contractOf(manifest)).not.toThrow();
  });

  it("is reached over the socket when the Assistant runs in its own container", async () => {
    const { core } = await apart(assistant(echo));
    const maya = await claimed(core);
    await running(core, assistantAppId);

    const asked = await ask(core, maya.token, { text: "Lights?" });

    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toEqual({
      reply:
        '"Lights?" from client Maya\'s MacBook in no room (en), with tools, 0 rooms',
    });
  });

  it("refuses an invalid socket reply and accepts the next valid reply", async () => {
    const invalid = deferredResult<unknown>();
    const app = assistant(async function (this: AppDefinition, ctx, request) {
      expect(ctx).not.toHaveProperty("storage");
      try {
        await request.reply({ text: "   " });
        invalid.resolve(undefined);
      } catch (error) {
        invalid.resolve(error);
      }
      await request.reply({ text: this.name });
    });
    const { core } = await apart(app);
    const maya = await claimed(core);
    await running(core, assistantAppId);

    const asked = await ask(core, maya.token, { text: "Hello" });

    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toEqual({ reply: app.name });
    expect(await invalid.promise).toBeInstanceOf(Error);
  });
});
