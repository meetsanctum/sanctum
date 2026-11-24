import type { ModelCheck, ModelTokens } from "@meetsanctum/app-sdk";

import { ask, ModelError, type ModelEndpoint } from "./client.js";

// Settings' check of a source: a short question with one tool, as an app's
// turn would ask, timed to the first piece of the answer. A model that
// answers without calling the tool still answers, but may not handle the
// home's tools well, and the check says so.

/** How long a check waits for the first word, and for the whole answer. */
const checkLimits = {
  firstWordInHomeMs: 90_000,
  firstWordProviderMs: 30_000,
  wholeMs: 120_000,
  // Room for a model that thinks before it calls the tool, as Claude and
  // OpenAI's reasoning models do: their thinking counts against it.
  maxTokens: 1_024,
};

const question = {
  messages: [
    {
      role: "system" as const,
      content:
        "You are checking that you can use tools. Call get_time to find the time, and don't guess it.",
    },
    { role: "user" as const, content: "What time is it?" },
  ],
  tools: [
    {
      name: "get_time",
      description: "Gets the current time.",
      input: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
};

type CheckResult = { check: ModelCheck; tokens: ModelTokens };

export async function checkSource(options: {
  endpoint: ModelEndpoint;
  model: string;
  inHome: boolean;
  now: () => Date;
  // Ends the check early, as when the core stops.
  signal?: AbortSignal;
}): Promise<CheckResult> {
  const started = performance.now();
  const at = options.now().toISOString();
  let firstWordMs: number | undefined;
  let answered = false;
  let usedTool = false;
  let tokens: ModelTokens = { read: 0, written: 0 };
  try {
    for await (const piece of ask(
      options.endpoint,
      { model: options.model, ...question, maxTokens: checkLimits.maxTokens },
      {
        signal: options.signal ?? new AbortController().signal,
        firstPieceMs: options.inHome
          ? checkLimits.firstWordInHomeMs
          : checkLimits.firstWordProviderMs,
        wholeMs: checkLimits.wholeMs,
        onFirstPiece: () => {
          firstWordMs = Math.round(performance.now() - started);
        },
      },
    )) {
      if (piece.type === "text") answered ||= piece.text.trim() !== "";
      if (piece.type === "tool") {
        answered = true;
        usedTool ||=
          piece.name === question.tools[0]!.name &&
          typeof piece.input === "object" &&
          piece.input !== null &&
          !Array.isArray(piece.input) &&
          Object.keys(piece.input).length === 0;
      }
      if (piece.type === "end") {
        tokens = piece.tokens;
        if (piece.stop === "unavailable") throw new ModelError("answer");
      }
    }
    if (!answered) throw new ModelError("answer", "the source gave no answer");
  } catch (error) {
    const problem = error instanceof ModelError ? error.problem : "answer";
    return { check: { at, outcome: "failed", problem }, tokens };
  }
  return {
    check: {
      at,
      outcome: usedTool ? "answered" : "noTool",
      ...(firstWordMs === undefined ? {} : { firstWordMs }),
    },
    tokens,
  };
}
