import type { ModelMessage, ModelSourceLook } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { ask, maxToolCalls, type ModelPiece } from "../src/models/client.js";
import type { KeptAnswers } from "../src/models/conversation.js";
import { endpointOf } from "../src/models/endpoints.js";
import { createTurns } from "../src/models/turns.js";
import { fakeSources, type FakeSources } from "./models-support.js";
import { claimed, post, testCore, type TestCore } from "./support.js";

// OpenAI as a provider: through the AI SDK's OpenAI provider and its
// Responses API, with nothing stored at OpenAI, the key sent only to OpenAI,
// and a reasoning model's sealed reasoning given back within a turn.

async function home(sources: FakeSources = fakeSources()) {
  const core = await testCore({ modelFetchers: sources.fetchers });
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

function streamAnswer(
  sources: FakeSources,
  messages: ModelMessage[],
  kept?: KeptAnswers,
) {
  return ask(
    endpointOf({ kind: "openai", key: sources.openAi.key }, sources.fetchers),
    {
      model: "gpt-5-mini",
      messages,
      tools: [
        {
          name: "lights",
          description: "Turns lights on or off.",
          input: { type: "object", properties: {} },
        },
      ],
      maxTokens: 512,
    },
    {
      signal: AbortSignal.timeout(5_000),
      firstPieceMs: 5_000,
      ...(kept ? { kept } : {}),
    },
  );
}

async function answer(...args: Parameters<typeof streamAnswer>) {
  const pieces: ModelPiece[] = [];
  for await (const piece of streamAnswer(...args)) {
    pieces.push(piece);
  }
  return pieces;
}

function toolAnswer(completed: number, unfinished = false) {
  const call = (index: number) => ({
    type: "function_call",
    id: `fc_${index}`,
    call_id: `call_${index}`,
    name: "lights",
  });
  const events: unknown[] = Array.from({ length: completed }, (_, index) => ({
    type: "response.output_item.done",
    output_index: index,
    item: { ...call(index), arguments: "{}", status: "completed" },
  }));
  if (unfinished) {
    events.push({
      type: "response.output_item.added",
      output_index: completed,
      item: { ...call(completed), arguments: "" },
    });
  }
  events.push({
    type: unfinished ? "response.incomplete" : "response.completed",
    response: {
      ...(unfinished && {
        incomplete_details: { reason: "max_output_tokens" },
      }),
      usage: { input_tokens: 50, output_tokens: 7 },
    },
  });
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("OpenAI as a source", () => {
  it("lists the models that chat, and is added and checked with nothing stored", async () => {
    const { core, token, sources } = await home();

    const look = await post(
      core,
      "/api/models/look",
      { kind: "openai", key: sources.openAi.key },
      { token },
    );
    expect(look.json<ModelSourceLook>()).toEqual({
      found: true,
      models: [{ id: "gpt-5-mini", name: "gpt-5-mini" }],
    });

    const added = await post(
      core,
      "/api/models/sources",
      { kind: "openai", key: sources.openAi.key, model: "gpt-5-mini" },
      { token },
    );
    expect(added.statusCode).toBe(200);
    const [source] = (await checked(core)).sources;

    expect(source).toMatchObject({
      kind: "openai",
      keyEnd: "9e3b",
      check: { outcome: "answered" },
      tokens: { today: 57 },
    });
    const [asked] = sources.chats as Record<string, unknown>[];
    expect(asked).toMatchObject({
      model: "gpt-5-mini",
      stream: true,
      store: false,
      tools: [expect.objectContaining({ name: "get_time" })],
    });
    expect(JSON.stringify(asked)).not.toContain(sources.openAi.key);
    for (const request of sources.requests) {
      expect(new URL(request.url).host).toBe("api.openai.com");
      expect(request.authorization).toBe(`Bearer ${sources.openAi.key}`);
    }
  });

  it("gives a reasoning model's sealed reasoning back, later in the same turn", async () => {
    const sources = fakeSources();
    sources.openAi.answer = { callsTool: true, thinks: true };
    const kept: KeptAnswers = new Map();
    const asked: ModelMessage[] = [{ role: "user", content: "Lights on" }];

    const first = await answer(sources, asked, kept);
    expect(first).toContainEqual({
      type: "tool",
      id: "call_1",
      name: "lights",
      input: {},
    });
    sources.openAi.answer = { text: ["Done."] };
    await answer(
      sources,
      [
        ...asked,
        {
          role: "assistant",
          content: "It's noon.",
          toolCalls: [{ id: "call_1", name: "lights", input: {} }],
        },
        { role: "tool", toolCallId: "call_1", content: "On" },
      ],
      kept,
    );

    const [initial, second] = sources.chats;
    expect(initial).toMatchObject({
      store: false,
      include: expect.arrayContaining(["reasoning.encrypted_content"]),
    });
    expect(second?.store).toBe(false);
    expect(second?.input).toContainEqual(
      expect.objectContaining({
        type: "reasoning",
        encrypted_content: "sealed-thought-1",
      }),
    );
  });

  it.each([
    {
      completed: maxToolCalls + 1,
      unfinished: false,
      last: "completed without a start",
    },
    {
      completed: maxToolCalls,
      unfinished: true,
      last: "cut off by the token limit",
    },
  ])(
    "rejects an answer whose call past the limit is $last",
    async ({ completed, unfinished }) => {
      const sources = fakeSources();
      sources.fetchers.internet = async () => toolAnswer(completed, unfinished);
      const stream = streamAnswer(sources, [
        { role: "user", content: "Lights on" },
      ]);
      await expect(stream.next()).rejects.toMatchObject({
        problem: "answer",
        message: "too many tool calls",
      });
    },
  );

  it("lets an app follow up with every call in an answer at the limit", async () => {
    const sources = fakeSources();
    const reach = { kind: "openai", key: sources.openAi.key } as const;
    const turns = createTurns({
      models: {
        inUse: () => ({
          id: "openai",
          model: "gpt-5-mini",
          shown: { name: "OpenAI", model: "gpt-5-mini", inHome: false },
          detail: { kind: "openai", model: "gpt-5-mini" },
          endpoint: () => endpointOf(reach, sources.fetchers),
        }),
        count: vi.fn(),
        onLeaving: vi.fn(),
      },
      record: () => "turn",
      log: vi.fn(),
    });
    const turn = turns.open({
      appId: "sanctum.example",
      appName: "Example",
      who: { actor: "user" },
    });
    const tools = [
      { name: "lights", description: "Turns the lights on.", input: {} },
    ];
    const reply = async (messages: ModelMessage[]) => {
      const handle = turn.open({ messages, tools }, () => ({
        signal: new AbortController().signal,
        done: vi.fn(),
      }));
      const pieces = await turn.read(handle, 0);
      while (pieces.at(-1)?.type !== "end") {
        pieces.push(...(await turn.read(handle, pieces.length)));
      }
      return pieces;
    };

    const fetcher = sources.fetchers.internet;
    const messages: ModelMessage[] = [{ role: "user", content: "Lights on" }];
    try {
      sources.fetchers.internet = async () => toolAnswer(maxToolCalls);
      const toolCalls = (await reply(messages))
        .filter((piece) => piece.type === "tool")
        .map(({ id, name, input }) => ({ id, name, input }));
      expect(toolCalls).toHaveLength(maxToolCalls);

      sources.fetchers.internet = fetcher;
      sources.openAi.answer = { text: ["Done."] };
      expect(
        await reply([
          ...messages,
          { role: "assistant", content: "", toolCalls },
          ...toolCalls.map((call) => ({
            role: "tool" as const,
            toolCallId: call.id,
            content: "On",
          })),
        ]),
      ).toContainEqual({ type: "text", text: "Done." });
    } finally {
      turn.end();
    }
  });
});
