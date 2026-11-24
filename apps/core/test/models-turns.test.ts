import {
  defineAction,
  defineApp,
  isActionError,
  modelsUsePermission,
  turnLimits,
  type AppContext,
  type ModelAnswerPiece,
  type ModelQuestion,
} from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { activity } from "../src/activity/schema.js";
import { maxResponseBytes } from "../src/models/client.js";
import { fakeSources, officeMac, type FakeSources } from "./models-support.js";
import { claimed, post, testCore, type TestCore } from "./support.js";

// Apps ask the home's AI model through the core with ctx.models, only within
// a turn: a person's or a shared device's call to an action that declares
// one. The answer streams by handle, the turn's caps hold, the tokens are
// counted for the app, and the activity log has one entry a turn with
// nothing said in it.

const question: ModelQuestion = {
  messages: [
    { role: "system", content: "You help at home." },
    { role: "user", content: "What time is it?" },
  ],
};

const tools: ModelQuestion["tools"] = [
  {
    name: "get_time",
    description: "The time now.",
    input: { type: "object", properties: {} },
  },
  {
    name: "find_room",
    description: "A room by name.",
    input: { type: "object", properties: { name: { type: "string" } } },
  },
];

// What an app's code got, or the code it was refused with.
async function attempt<T>(work: () => Promise<T>) {
  try {
    return { got: await work() };
  } catch (error) {
    if (isActionError(error)) return { refused: error.code };
    throw error;
  }
}

async function piecesOf(ctx: AppContext, asked: ModelQuestion) {
  const pieces: ModelAnswerPiece[] = [];
  for await (const piece of ctx.models.answer(asked)) pieces.push(piece);
  return pieces;
}

const input = z.object({
  tools: z.boolean().optional(),
  maxTokens: z.number().optional(),
  answers: z.number().optional(),
  nextModel: z.string().optional(),
  waitMs: z.number().optional(),
});

const ask = defineAction({
  id: "example.ask",
  title: "Ask",
  tier: "read",
  turn: true,
  input,
  output: z.unknown(),
  async run(ctx, asked) {
    const source = await ctx.models.source();
    const answers = [];
    for (let each = 0; each < (asked.answers ?? 1); each += 1) {
      if (each > 0 && asked.nextModel) {
        await vi.waitFor(async () =>
          expect((await ctx.models.source())?.model).toBe(asked.nextModel),
        );
      }
      answers.push(
        await attempt(() =>
          piecesOf(ctx, {
            ...question,
            ...(asked.tools
              ? {
                  tools,
                  messages: [
                    ...question.messages,
                    {
                      role: "assistant",
                      content: "",
                      toolCalls: [
                        { id: "earlier", name: "get_time", input: null },
                      ],
                    },
                    { role: "tool", toolCallId: "earlier", content: "Noon." },
                  ],
                }
              : {}),
            ...(asked.maxTokens ? { maxTokens: asked.maxTokens } : {}),
          }),
        ),
      );
    }
    if (asked.waitMs) {
      await new Promise((resolve) => setTimeout(resolve, asked.waitMs));
    }
    return { source, answers };
  },
});

// Asks without a turn of its own.
const plain = defineAction({
  id: "example.plain",
  title: "Ask without a turn",
  tier: "read",
  input,
  output: z.unknown(),
  async run(ctx, asked) {
    if (asked.waitMs) {
      await new Promise((resolve) => setTimeout(resolve, asked.waitMs));
    }
    return {
      source: await ctx.models.source(),
      answer: await attempt(() => ctx.models.answer(question).text()),
    };
  },
});

// Starts an answer and returns before it's done.
const leave = defineAction({
  id: "example.leave",
  title: "Start an answer and go",
  tier: "read",
  turn: true,
  input,
  output: z.unknown(),
  async run(ctx) {
    const answer = ctx.models.answer(question);
    const reader = answer[Symbol.asyncIterator]();
    return (await reader.next()).value;
  },
});

// Reads one piece, then cancels.
const cancel = defineAction({
  id: "example.cancel",
  title: "Start an answer and cancel it",
  tier: "read",
  turn: true,
  input,
  output: z.unknown(),
  async run(ctx) {
    const answer = ctx.models.answer(question);
    const pieces: ModelAnswerPiece[] = [];
    for await (const piece of answer) {
      pieces.push(piece);
      if (piece.type === "text") await answer.cancel();
    }
    return pieces;
  },
});

const example = defineApp({
  id: "sanctum.example",
  name: "Example",
  version: "0.1.0",
  core: "^2.0.0",
  permissions: [
    { id: modelsUsePermission, reason: "To answer you.", needed: true },
  ],
  actions: [ask, plain, leave, cancel],
  events: [],
});

const without = defineApp({
  id: "sanctum.without",
  name: "Without",
  version: "0.1.0",
  core: "^2.0.0",
  permissions: [],
  actions: [ask],
  events: [],
});

async function home(
  sources: FakeSources = fakeSources(),
  options: { appTimeoutMs?: number } = {},
) {
  const core = await testCore({
    modelFetchers: sources.fetchers,
    apps: [
      { app: example, origin: "official" },
      { app: without, origin: "official" },
    ],
    ...options,
  });
  const maya = await claimed(core);
  return { core, maya, sources };
}

async function withOfficeMac(core: TestCore, token: string) {
  const added = await post(
    core,
    "/api/models/sources",
    {
      kind: "computer",
      address: officeMac,
      computer: "Office Mac",
      model: "qwen3:8b",
    },
    { token },
  );
  expect(added.statusCode).toBe(200);
  await vi.waitFor(() => {
    expect(core.models.info().sources[0]?.check).toBeDefined();
  });
}

type Asked = {
  source: unknown;
  answers: { got?: ModelAnswerPiece[]; refused?: string }[];
};

const turns = (core: TestCore) =>
  core.db
    .select()
    .from(activity)
    .where(eq(activity.action, "models.turn"))
    .all();

describe("an app's turn with the home's AI model", () => {
  it("streams the answer to a person's call, and counts its tokens for the app", async () => {
    const { core, maya, sources } = await home();
    await withOfficeMac(core, maya.token);
    sources.ollama.answer = {
      text: ["It's ", "half ", "past ten."],
      tokens: { read: 120, written: 9 },
    };

    const asked = await post(
      core,
      "/api/apps/sanctum.example/actions/example.ask",
      {},
      maya,
    );

    expect(asked.statusCode).toBe(200);
    expect(asked.json<Asked>()).toEqual({
      source: { name: "Office Mac", model: "Qwen3 8B", inHome: true },
      answers: [
        {
          got: [
            { type: "text", text: "It's " },
            { type: "text", text: "half " },
            { type: "text", text: "past ten." },
            { type: "end", stop: "done", tokens: { read: 120, written: 9 } },
          ],
        },
      ],
    });
    expect(core.models.info().apps).toEqual([
      {
        id: "sanctum.example",
        name: "Example",
        tokens: { today: 129, month: 129 },
      },
    ]);
    const [entry] = turns(core);
    expect(entry).toMatchObject({
      source: "models",
      outcome: "ok",
      personId: maya.person.id,
      detail: {
        app: "sanctum.example",
        appName: "Example",
        kind: "computer",
        model: "Qwen3 8B",
        computer: "Office Mac",
        answers: 1,
        tokens: 129,
      },
    });
    // Nothing that was said.
    expect(JSON.stringify(entry)).not.toContain("half past");
    expect(JSON.stringify(entry)).not.toContain("What time");
  });

  it("passes the conversation on, sorts the tools by name, and caps the tokens", async () => {
    const { core, maya, sources } = await home();
    await withOfficeMac(core, maya.token);
    sources.ollama.answer = { callsTool: true };
    sources.chats.length = 0;

    const asked = await post(
      core,
      "/api/apps/sanctum.example/actions/example.ask",
      { tools: true },
      maya,
    );

    const [answer] = asked.json<Asked>().answers;
    expect(answer?.got).toContainEqual({
      type: "tool",
      id: "call-1",
      name: "get_time",
      input: {},
    });
    expect(answer?.got?.at(-1)).toMatchObject({ type: "end", stop: "tool" });
    const [chat] = sources.chats;
    expect(chat?.messages).toEqual([
      { role: "system", content: "You help at home." },
      { role: "user", content: "What time is it?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "earlier",
            type: "function",
            // A call without input goes as an empty object, as every tool's
            // input is.
            function: { name: "get_time", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "earlier", content: "Noon." },
    ]);
    expect(
      (chat?.tools as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      ),
    ).toEqual(["find_room", "get_time"]);
    expect(chat?.max_tokens).toBe(turnLimits.maxTokens);

    const over = await post(
      core,
      "/api/apps/sanctum.example/actions/example.ask",
      { maxTokens: turnLimits.maxTokens + 1 },
      maya,
    );
    expect(over.statusCode).toBe(500);
  });

  it("has no turn for a call that doesn't open one", async () => {
    const { core, maya } = await home();
    await withOfficeMac(core, maya.token);

    // An action without a turn, called by a person.
    const plainCall = await post(
      core,
      "/api/apps/sanctum.example/actions/example.plain",
      {},
      maya,
    );
    expect(plainCall.json()).toEqual({
      source: { name: "Office Mac", model: "Qwen3 8B", inHome: true },
      answer: { refused: "no_turn" },
    });

    // An action with one, run by a workflow or by the app itself.
    for (const actor of [
      { kind: "workflow", id: "workflow-1" },
      { kind: "app", id: "sanctum.example" },
    ] as const) {
      const ran = (await core.apps.invoke({
        actor,
        appId: "sanctum.example",
        actionId: "example.ask",
        input: {},
      })) as Asked;
      expect(ran.answers).toEqual([{ refused: "no_turn" }]);
    }
    expect(turns(core)).toEqual([]);
  });

  it("refuses an app that doesn't hold models.use", async () => {
    const { core, maya, sources } = await home();
    await withOfficeMac(core, maya.token);
    sources.chats.length = 0;

    const asked = await post(
      core,
      "/api/apps/sanctum.without/actions/example.ask",
      {},
      maya,
    );

    expect(asked.statusCode).toBe(500);
    expect(sources.chats).toEqual([]);
    expect(core.models.info().apps.map((app) => app.id)).toEqual([
      "sanctum.example",
    ]);
  });

  it("ends an answer unavailable while no source is in use", async () => {
    const { core, maya } = await home();

    const asked = await post(
      core,
      "/api/apps/sanctum.example/actions/example.ask",
      {},
      maya,
    );

    expect(asked.json<Asked>()).toEqual({
      source: null,
      answers: [
        {
          got: [
            {
              type: "end",
              stop: "unavailable",
              tokens: { read: 0, written: 0 },
            },
          ],
        },
      ],
    });
    expect(turns(core)).toMatchObject([
      { outcome: "failed", reason: "unavailable", detail: { answers: 1 } },
    ]);
  });

  it("ends an answer unavailable when the source doesn't answer", async () => {
    const { core, maya, sources } = await home();
    await withOfficeMac(core, maya.token);
    sources.ollama.up = false;

    const asked = await post(
      core,
      "/api/apps/sanctum.example/actions/example.ask",
      {},
      maya,
    );

    expect(asked.json<Asked>().answers[0]?.got).toEqual([
      { type: "end", stop: "unavailable", tokens: { read: 0, written: 0 } },
    ]);
    expect(turns(core)).toMatchObject([
      { outcome: "failed", detail: { model: "Qwen3 8B" } },
    ]);
  });

  it.each([
    { reason: "empty", answer: { text: [] } },
    { reason: "oversized", answer: { text: ["x".repeat(maxResponseBytes)] } },
    {
      reason: "too large to deliver a whole tool call",
      answer: {
        text: [],
        callsTool: true,
        toolArguments: JSON.stringify({ value: "x".repeat(64 * 1024) }),
      },
    },
  ])(
    "ends an answer unavailable when the response is $reason",
    async ({ answer }) => {
      const { core, maya, sources } = await home();
      await withOfficeMac(core, maya.token);
      sources.ollama.answer = answer;

      const asked = await post(
        core,
        "/api/apps/sanctum.example/actions/example.ask",
        {},
        maya,
      );

      expect(asked.json<Asked>().answers[0]?.got).toMatchObject([
        { type: "end", stop: "unavailable" },
      ]);
    },
  );

  it("asks for at most eight answers a turn", async () => {
    const { core, maya } = await home();
    await withOfficeMac(core, maya.token);

    const asked = await post(
      core,
      "/api/apps/sanctum.example/actions/example.ask",
      { answers: turnLimits.answers + 1 },
      maya,
    );

    const { answers } = asked.json<Asked>();
    expect(answers).toHaveLength(turnLimits.answers + 1);
    expect(answers.slice(0, turnLimits.answers).every((each) => each.got)).toBe(
      true,
    );
    expect(answers.at(-1)).toEqual({ refused: "limited" });
    expect(turns(core)).toMatchObject([
      { detail: { answers: turnLimits.answers } },
    ]);
  });

  it("stops an answer the app cancels", async () => {
    const { core, maya, sources } = await home();
    await withOfficeMac(core, maya.token);
    sources.ollama.answer = { text: ["It's "], hangs: true };

    const cancelled = await post(
      core,
      "/api/apps/sanctum.example/actions/example.cancel",
      {},
      maya,
    );

    expect(cancelled.json()).toEqual([
      { type: "text", text: "It's " },
      { type: "end", stop: "cancelled", tokens: { read: 0, written: 0 } },
    ]);
    await vi.waitFor(() => expect(sources.stopped).toBe(1));
  });

  it("stops an open answer when its permission is taken away", async () => {
    const { core, maya, sources } = await home();
    await withOfficeMac(core, maya.token);
    sources.chats.length = 0;
    sources.ollama.answer = { hangs: true };

    const asking = post(
      core,
      "/api/apps/sanctum.example/actions/example.ask",
      {},
      maya,
    );
    await vi.waitFor(() => expect(sources.chats).toHaveLength(1));
    const revoked = await post(
      core,
      "/api/apps/sanctum.example/permissions/update",
      { permission: modelsUsePermission, granted: false },
      maya,
    );

    expect(revoked.statusCode).toBe(200);
    await vi.waitFor(() => expect(sources.stopped).toBe(1));
    expect((await asking).statusCode).toBe(500);
  });

  it("stops what's under way when the turn ends with its call", async () => {
    const { core, maya, sources } = await home();
    await withOfficeMac(core, maya.token);
    sources.ollama.answer = { text: ["It's "], hangs: true };

    const left = await post(
      core,
      "/api/apps/sanctum.example/actions/example.leave",
      {},
      maya,
    );

    expect(left.json()).toEqual({ type: "text", text: "It's " });
    await vi.waitFor(() => expect(sources.stopped).toBe(1));
    expect(turns(core)).toHaveLength(1);
  });

  it("ends an answer unavailable when its source stops being the one in use", async () => {
    const { core, maya, sources } = await home();
    await withOfficeMac(core, maya.token);
    const id = core.models.info().sources[0]!.id;
    sources.chats.length = 0;
    sources.ollama.answer = { text: ["It's "], hangs: true };

    const asking = post(
      core,
      "/api/apps/sanctum.example/actions/example.ask",
      {},
      maya,
    );
    await vi.waitFor(() => expect(sources.chats).toHaveLength(1));
    core.models.remove(id, { clientId: maya.client.id });

    expect((await asking).json<Asked>().answers[0]?.got?.at(-1)).toEqual({
      type: "end",
      stop: "unavailable",
      tokens: { read: 0, written: 0 },
    });
    await vi.waitFor(() => expect(sources.stopped).toBe(1));
  });

  it("gives a turn its own time, longer than an action's", async () => {
    const { core, maya } = await home(fakeSources(), { appTimeoutMs: 300 });
    await withOfficeMac(core, maya.token);

    const plainCall = await post(
      core,
      "/api/apps/sanctum.example/actions/example.plain",
      { waitMs: 600 },
      maya,
    );
    const turnCall = await post(
      core,
      "/api/apps/sanctum.example/actions/example.ask",
      { waitMs: 600 },
      maya,
    );

    expect(plainCall.statusCode).toBe(504);
    expect(turnCall.statusCode).toBe(200);
  });

  it("attributes usage to both models when the model changes between answers", async () => {
    const { core, maya, sources } = await home();
    await withOfficeMac(core, maya.token);
    const id = core.models.info().sources[0]!.id;
    sources.ollama.answer = {
      text: ["Noon."],
      tokens: { read: 10, written: 2 },
    };

    const asking = post(
      core,
      "/api/apps/sanctum.example/actions/example.ask",
      { answers: 2, nextModel: "Llama3.2 3B" },
      maya,
    );
    await vi.waitFor(() =>
      expect(core.models.info().apps[0]?.tokens.today).toBe(12),
    );
    await core.models.change(
      id,
      { model: "llama3.2:3b" },
      { clientId: maya.client.id },
    );

    expect((await asking).statusCode).toBe(200);
    expect(turns(core)).toMatchObject([
      {
        subjectId: null,
        detail: {
          models: [{ model: "Qwen3 8B" }, { model: "Llama3.2 3B" }],
          tokens: 24,
        },
      },
    ]);
    expect(turns(core)[0]?.detail).not.toHaveProperty("model");
  });

  it("takes no more turns once the core is stopping", async () => {
    const { core, maya, sources } = await home();
    await withOfficeMac(core, maya.token);
    sources.chats.length = 0;
    core.turns.close();

    const asked = await post(
      core,
      "/api/apps/sanctum.example/actions/example.ask",
      {},
      maya,
    );

    expect(asked.json<Asked>().answers[0]?.got).toEqual([
      { type: "end", stop: "unavailable", tokens: { read: 0, written: 0 } },
    ]);
    expect(sources.chats).toEqual([]);
  });
});
