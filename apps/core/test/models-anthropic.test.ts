import {
  defineAction,
  defineApp,
  modelsUsePermission,
  type ModelAnswerPiece,
  type ModelMessage,
  type ModelSourceLook,
  type ModelTool,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { messagesOf, type KeptAnswers } from "../src/models/anthropic.js";
import type { ModelPiece } from "../src/models/client.js";
import { ask, endpointOf } from "../src/models/endpoints.js";
import { fakeSources, type FakeSources } from "./models-support.js";
import { claimed, post, testCore, type TestCore } from "./support.js";

// Anthropic as a provider: Claude through Anthropic's own Messages API, with
// the key sent only to Anthropic, Claude's thinking given back as it came
// within a turn, and what it reads from its cache counted with the rest.

// Asks Claude, runs the tool it called, and asks again with the result, as
// an assistant's turn does.
const loop = defineAction({
  id: "example.loop",
  title: "Ask, use a tool, ask again",
  tier: "read",
  turn: true,
  input: z.object({}),
  output: z.unknown(),
  async run(ctx) {
    const messages: ModelMessage[] = [
      { role: "system", content: "You run a home." },
      { role: "user", content: "Lights on" },
    ];
    const tools = [
      {
        name: "lights",
        description: "Turns lights on or off.",
        input: { type: "object", properties: {} },
      },
    ];
    const first: ModelAnswerPiece[] = [];
    for await (const piece of ctx.models.answer({ messages, tools })) {
      first.push(piece);
    }
    const calls = first.flatMap((piece) =>
      piece.type === "tool"
        ? [{ id: piece.id, name: piece.name, input: piece.input }]
        : [],
    );
    const text = first
      .map((piece) => (piece.type === "text" ? piece.text : ""))
      .join("");
    return ctx.models
      .answer({
        messages: [
          ...messages,
          { role: "assistant", content: text, toolCalls: calls },
          ...calls.map((call) => ({
            role: "tool" as const,
            toolCallId: call.id,
            content: "On",
          })),
        ],
        tools,
      })
      .text();
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
  actions: [loop],
  events: [],
});

async function home(sources: FakeSources = fakeSources()) {
  const core = await testCore({
    modelFetchers: sources.fetchers,
    apps: [{ app: example, origin: "official" }],
  });
  const { token } = await claimed(core);
  return { core, token, sources };
}

async function checked(core: TestCore) {
  await vi.waitFor(() => {
    expect(core.models.info().sources.some((each) => each.checking)).toBe(
      false,
    );
  });
  return core.models.info();
}

async function answer(
  sources: FakeSources,
  messages: Parameters<typeof ask>[1]["messages"],
  kept?: KeptAnswers,
  tools: ModelTool[] = [
    {
      name: "lights",
      description: "Turns lights on or off.",
      input: { type: "object", properties: { to: { type: "string" } } },
    },
  ],
) {
  const pieces: ModelPiece[] = [];
  for await (const piece of ask(
    endpointOf(
      { kind: "anthropic", key: sources.anthropic.key },
      sources.fetchers,
    ),
    {
      model: "claude-sonnet-5-5",
      messages,
      tools,
      maxTokens: 512,
      ...(kept ? { kept } : {}),
    },
    AbortSignal.timeout(5_000),
  )) {
    pieces.push(piece);
  }
  return pieces;
}

describe("Anthropic as a source", () => {
  it("lists the models a key may use, and refuses a key that opens nothing", async () => {
    const { core, token, sources } = await home();

    const look = await post(
      core,
      "/api/models/look",
      { kind: "anthropic", key: sources.anthropic.key },
      { token },
    );
    expect(look.json<ModelSourceLook>()).toEqual({
      found: true,
      models: [
        { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
        { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      ],
    });

    const wrong = await post(
      core,
      "/api/models/look",
      { kind: "anthropic", key: "sk-ant-api03-not-this-one" },
      { token },
    );
    expect(wrong.json<ModelSourceLook>()).toEqual({
      found: false,
      problem: "key",
    });
  });

  it("is added and checked, with the key sent only to Anthropic", async () => {
    const { core, token, sources } = await home();
    sources.anthropic.answer = { callsTool: true, thinks: true };

    const added = await post(
      core,
      "/api/models/sources",
      {
        kind: "anthropic",
        key: sources.anthropic.key,
        model: "claude-sonnet-5-5",
      },
      { token },
    );
    expect(added.statusCode).toBe(200);
    const [source] = (await checked(core)).sources;

    expect(source).toMatchObject({
      kind: "anthropic",
      modelName: "Claude Sonnet 5.5",
      keyEnd: "7c1d",
      check: { outcome: "answered" },
      // What it read, from its cache too, and what it wrote.
      tokens: { today: 48 },
    });
    expect(core.models.inUse()?.shown).toEqual({
      name: "Anthropic",
      model: "Claude Sonnet 5.5",
      inHome: false,
    });
    const [asked] = sources.chats as Record<string, unknown>[];
    expect(asked).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 1024,
      stream: true,
      cache_control: { type: "ephemeral" },
      system: expect.stringContaining("Call get_time"),
      messages: [{ role: "user", content: "What time is it?" }],
      tools: [{ name: "get_time", input_schema: { type: "object" } }],
    });
    expect(JSON.stringify(asked)).not.toContain(sources.anthropic.key);
    expect(sources.requests).not.toHaveLength(0);
    for (const request of sources.requests) {
      expect(new URL(request.url).host).toBe("api.anthropic.com");
      expect(request.authorization).toBe(`Bearer ${sources.anthropic.key}`);
    }
  });

  it("uses the household's key even when the SDK has custom headers", async () => {
    const { core, token, sources } = await home();
    vi.stubEnv(
      "ANTHROPIC_CUSTOM_HEADERS",
      "Authorization: Bearer another-key\nX-Api-Key: another-key",
    );
    try {
      const look = await post(
        core,
        "/api/models/look",
        { kind: "anthropic", key: sources.anthropic.key },
        { token },
      );
      expect(look.json<ModelSourceLook>()).toMatchObject({ found: true });
      expect(sources.requests[0]?.authorization).toBe(
        `Bearer ${sources.anthropic.key}`,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("says a check whose model declined failed", async () => {
    const { core, token, sources } = await home();
    sources.anthropic.answer = { stopReason: "refusal" };

    await post(
      core,
      "/api/models/sources",
      {
        kind: "anthropic",
        key: sources.anthropic.key,
        model: "claude-sonnet-5-5",
      },
      { token },
    );
    const [source] = (await checked(core)).sources;

    expect(source).toMatchObject({
      check: { outcome: "failed", problem: "answer" },
      tokens: { today: 48 },
    });
  });
});

describe("a turn with Claude", () => {
  it("gives Claude's thinking back when the app asks again with the tool's result", async () => {
    const { core, token, sources } = await home();
    sources.anthropic.answer = { callsTool: true, thinks: true };
    await post(
      core,
      "/api/models/sources",
      {
        kind: "anthropic",
        key: sources.anthropic.key,
        model: "claude-sonnet-5-5",
      },
      { token },
    );
    await checked(core);
    sources.chats.length = 0;

    let asked = 0;
    const fetchers = sources.fetchers.internet;
    sources.fetchers.internet = async (input, init) => {
      if (String(input).endsWith("/v1/messages") && (asked += 1) === 2) {
        sources.anthropic.answer = { text: ["Done."] };
      }
      return fetchers(input, init);
    };
    const called = await post(
      core,
      "/api/apps/sanctum.example/actions/example.loop",
      {},
      { token },
    );

    expect(called.json()).toBe("Done.");
    const [, again] = sources.chats as { messages: { role: string }[] }[];
    expect(again?.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-thought-1" },
        expect.objectContaining({ type: "text", text: "It's noon." }),
        { type: "tool_use", id: "toolu_1", name: "lights", input: {} },
      ],
    });
  });
});

describe("Claude's answers", () => {
  it("stream text, then the tool call whole, then the end", async () => {
    const sources = fakeSources();
    sources.anthropic.answer = {
      callsTool: true,
      toolArguments: '{"to":"on"}',
      tokens: { read: 100, written: 12 },
    };

    expect(
      await answer(sources, [{ role: "user", content: "Lights on" }]),
    ).toEqual([
      { type: "text", text: "It's " },
      { type: "text", text: "noon." },
      { type: "tool", id: "toolu_1", name: "lights", input: { to: "on" } },
      { type: "end", stop: "tool", tokens: { read: 110, written: 12 } },
    ]);
  });

  it("give Claude's thinking back as it came, later in the same turn", async () => {
    const sources = fakeSources();
    sources.anthropic.answer = { callsTool: true, thinks: true };
    const kept: KeptAnswers = new Map();
    const asked = [
      { role: "system" as const, content: "You run a home." },
      { role: "user" as const, content: "Lights on" },
    ];

    await answer(sources, asked, kept);
    sources.anthropic.answer = { text: ["Done."] };
    await answer(
      sources,
      [
        ...asked,
        {
          role: "assistant",
          content: "It's noon.",
          toolCalls: [{ id: "toolu_1", name: "lights", input: {} }],
        },
        { role: "tool", toolCallId: "toolu_1", content: "On" },
      ],
      kept,
    );

    const second = sources.chats[1] as { system: string; messages: unknown[] };
    expect(second.system).toBe("You run a home.");
    expect(second.messages).toEqual([
      { role: "user", content: "Lights on" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig-thought-1" },
          expect.objectContaining({ type: "text", text: "It's noon." }),
          { type: "tool_use", id: "toolu_1", name: "lights", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "On" },
        ],
      },
    ]);
  });

  it("stop at the limit without a tool call cut short", async () => {
    const sources = fakeSources();
    sources.anthropic.answer = {
      callsTool: true,
      toolArguments: '{"to":',
      stopReason: "max_tokens",
    };

    const pieces = await answer(sources, [{ role: "user", content: "Hi" }]);

    expect(pieces.filter((piece) => piece.type === "tool")).toEqual([]);
    expect(pieces.at(-1)).toMatchObject({ type: "end", stop: "limit" });
  });

  it("reject an incomplete tool input when Claude says the call is ready", async () => {
    const sources = fakeSources();
    sources.anthropic.answer = { callsTool: true, toolArguments: '{"to":"on"' };

    await expect(
      answer(sources, [{ role: "user", content: "Lights on" }]),
    ).rejects.toMatchObject({ problem: "answer" });
  });

  it("reject invalid tokens before issuing tool calls", async () => {
    const sources = fakeSources();
    sources.anthropic.answer = {
      callsTool: true,
      tokens: { read: 30, written: -1 },
    };
    const pieces = ask(
      endpointOf(
        { kind: "anthropic", key: sources.anthropic.key },
        sources.fetchers,
      ),
      {
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 64,
      },
      AbortSignal.timeout(5_000),
    );

    await expect(pieces.next()).resolves.toMatchObject({
      value: { type: "text" },
    });
    await expect(pieces.next()).resolves.toMatchObject({
      value: { type: "text" },
    });
    await expect(pieces.next()).rejects.toMatchObject({ problem: "answer" });
  });

  it.each(["system", "tools", "user", "assistant"] as const)(
    "leave out kept thinking when the app changes the %s",
    async (changed) => {
      const sources = fakeSources();
      sources.anthropic.answer = { callsTool: true, thinks: true };
      const kept: KeptAnswers = new Map();
      const initial: ModelMessage[] = [
        { role: "system", content: "You run a home." },
        { role: "user", content: "Lights on" },
      ];
      await answer(sources, initial, kept);

      sources.anthropic.answer = { text: ["Done."] };
      const assistant = changed === "assistant" ? "Edited text." : "It's noon.";
      await answer(
        sources,
        [
          {
            role: "system",
            content: changed === "system" ? "Be brief." : initial[0]!.content,
          },
          {
            role: "user",
            content: changed === "user" ? "Lights off" : initial[1]!.content,
          },
          {
            role: "assistant",
            content: assistant,
            toolCalls: [{ id: "toolu_1", name: "lights", input: {} }],
          },
          { role: "tool", toolCallId: "toolu_1", content: "On" },
        ],
        kept,
        changed === "tools" ? [] : undefined,
      );

      const second = sources.chats[1] as { messages: unknown[] };
      expect(second.messages[1]).toEqual({
        role: "assistant",
        content: [
          { type: "text", text: assistant },
          { type: "tool_use", id: "toolu_1", name: "lights", input: {} },
        ],
      });
    },
  );

  it("say a key that opens nothing is the key's problem", async () => {
    const sources = fakeSources();
    const pieces = ask(
      endpointOf({ kind: "anthropic", key: "sk-ant-wrong" }, sources.fetchers),
      {
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 64,
      },
      AbortSignal.timeout(5_000),
    );

    await expect(pieces.next()).rejects.toMatchObject({ problem: "key" });
  });
});

describe("the conversation Claude reads", () => {
  it("has the system prompt apart and tool results that follow each other together", () => {
    expect(
      messagesOf([
        { role: "system", content: "You run a home." },
        { role: "user", content: "Lights on, and the fan" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "a", name: "lights", input: { to: "on" } },
            { id: "b", name: "fan", input: null },
          ],
        },
        { role: "tool", toolCallId: "a", content: "On" },
        { role: "tool", toolCallId: "b", content: "Running" },
        { role: "system", content: "Answer briefly." },
      ]),
    ).toEqual({
      system: "You run a home.",
      messages: [
        { role: "user", content: "Lights on, and the fan" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "lights", input: { to: "on" } },
            { type: "tool_use", id: "b", name: "fan", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a", content: "On" },
            { type: "tool_result", tool_use_id: "b", content: "Running" },
          ],
        },
        { role: "user", content: "Answer briefly." },
      ],
    });
  });
});
