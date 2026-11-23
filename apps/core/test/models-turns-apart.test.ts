import {
  defineAction,
  defineApp,
  isActionError,
  modelsUsePermission,
  type ModelAnswerPiece,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { apart, base, running, useCleanUps } from "./app-apart-support.js";
import { fakeSources, officeMac } from "./models-support.js";
import { claimed, post } from "./support.js";

// An app in its own container reads the home's AI model's answer by its
// handle over the socket: one message a call, so a long answer is many
// reads, each held a moment for the next piece.

useCleanUps();

const question = {
  messages: [{ role: "user" as const, content: "Tell me a long story." }],
};

const route = "/api/apps/sanctum.example/actions";

const app = defineApp({
  ...base,
  id: "sanctum.example",
  permissions: [
    { id: modelsUsePermission, reason: "To answer you.", needed: true },
  ],
  actions: [
    defineAction({
      id: "example.reread",
      title: "Read an answer twice",
      tier: "read",
      turn: true,
      input: z.object({}),
      output: z.unknown(),
      async run(ctx) {
        const answer = ctx.models.answer(question);
        for await (const piece of answer) {
          if (piece.type === "text") break;
        }
        return Promise.all([answer.text(), answer.text()]);
      },
    }),
    defineAction({
      id: "example.ask",
      title: "Ask",
      tier: "read",
      turn: true,
      input: z.object({}),
      output: z.unknown(),
      async run(ctx) {
        const pieces: ModelAnswerPiece[] = [];
        for await (const piece of ctx.models.answer(question)) {
          pieces.push(piece);
        }
        return pieces;
      },
    }),
    defineAction({
      id: "example.plain",
      title: "Ask without a turn",
      tier: "read",
      input: z.object({}),
      output: z.unknown(),
      async run(ctx) {
        try {
          return await ctx.models.answer(question).text();
        } catch (error) {
          if (isActionError(error)) return { refused: error.code };
          throw error;
        }
      },
    }),
  ],
});

async function withSource() {
  const sources = fakeSources();
  const { core } = await apart(app, { modelFetchers: sources.fetchers });
  const maya = await claimed(core);
  await running(core, "sanctum.example");
  await post(
    core,
    "/api/models/sources",
    {
      kind: "computer",
      address: officeMac,
      computer: "Office Mac",
      model: "qwen3:8b",
    },
    maya,
  );
  await vi.waitFor(() =>
    expect(core.models.info().sources[0]?.check).toBeDefined(),
  );
  return { core, maya, sources };
}

describe("an app apart asking the home's AI model", () => {
  it("reads a long answer in pieces, over many reads", async () => {
    const { core, maya, sources } = await withSource();
    const words = Array.from(
      { length: 40 },
      (_, each) => `${each}:${"x".repeat(4_000)} `,
    );
    words.push("🏠".repeat(20_000));
    sources.ollama.answer = { text: words };

    const asked = await post(core, `${route}/example.ask`, {}, maya);
    expect(asked.statusCode).toBe(200);
    const pieces = asked.json<ModelAnswerPiece[]>();
    const texts = pieces.filter((piece) => piece.type === "text");
    for (const { text } of texts) {
      expect(Buffer.from(text).toString("utf8")).toBe(text);
    }
    expect(
      texts.every(
        (piece) => Buffer.byteLength(JSON.stringify([piece])) <= 64 * 1024,
      ),
    ).toBe(true);
    expect(texts.map((piece) => piece.text).join("")).toBe(words.join(""));
    expect(pieces.at(-1)).toMatchObject({ type: "end", stop: "done" });
  });

  it("lets readers get the whole answer after an earlier reader breaks", async () => {
    const { core, maya, sources } = await withSource();
    sources.ollama.answer = { text: ["It's ", "noon."] };
    sources.chats.length = 0;

    const asked = await post(core, `${route}/example.reread`, {}, maya);

    expect(asked.json()).toEqual(["It's noon.", "It's noon."]);
    expect(sources.chats).toHaveLength(1);
  });

  it("is refused no_turn without a turn", async () => {
    const { core } = await apart(app, {
      modelFetchers: fakeSources().fetchers,
    });
    const maya = await claimed(core);
    await running(core, "sanctum.example");

    const asked = await post(core, `${route}/example.plain`, {}, maya);

    expect(asked.json()).toEqual({ refused: "no_turn" });
  });
});
