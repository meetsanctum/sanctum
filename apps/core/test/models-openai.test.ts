import type { ModelMessage, ModelSourceLook } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { ask, type ModelPiece } from "../src/models/client.js";
import type { KeptAnswers } from "../src/models/conversation.js";
import { endpointOf } from "../src/models/endpoints.js";
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

async function answer(
  sources: FakeSources,
  messages: ModelMessage[],
  kept?: KeptAnswers,
) {
  const pieces: ModelPiece[] = [];
  for await (const piece of ask(
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
  )) {
    pieces.push(piece);
  }
  return pieces;
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

    const [, second] = sources.chats as { store: boolean; input: unknown[] }[];
    expect(second?.store).toBe(false);
    expect(second?.input).toContainEqual(
      expect.objectContaining({
        type: "reasoning",
        encrypted_content: "sealed-thought-1",
      }),
    );
  });
});
