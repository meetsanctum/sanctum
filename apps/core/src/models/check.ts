import type { ModelCheck } from "@meetsanctum/app-sdk";

import {
  chat,
  ModelError,
  type ModelEndpoint,
  type ModelTokens,
} from "./client.js";

// Settings' check of a source: a short question with one tool, as an app's
// turn would ask, timed to the first piece of the answer. A model that
// answers without calling the tool still answers, but may not handle the
// home's tools well, and the check says so.

/** How long a check waits for the first word, and for the whole answer. */
export const checkLimits = {
  firstWordInHomeMs: 90_000,
  firstWordProviderMs: 30_000,
  wholeMs: 120_000,
  maxTokens: 256,
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

export type CheckResult = { check: ModelCheck; tokens: ModelTokens };

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
  const firstWord = new AbortController();
  const firstWordTimer = setTimeout(
    () => firstWord.abort(new ModelError("timeout", "no first word in time")),
    options.inHome
      ? checkLimits.firstWordInHomeMs
      : checkLimits.firstWordProviderMs,
  );
  const signal = AbortSignal.any([
    firstWord.signal,
    AbortSignal.timeout(checkLimits.wholeMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  let firstWordMs: number | undefined;
  let usedTool = false;
  let tokens: ModelTokens = { read: 0, written: 0 };
  try {
    for await (const piece of chat(
      options.endpoint,
      { model: options.model, ...question, maxTokens: checkLimits.maxTokens },
      signal,
    )) {
      if (firstWordMs === undefined) {
        firstWordMs = Math.round(performance.now() - started);
        clearTimeout(firstWordTimer);
      }
      if (piece.type === "tool") usedTool = true;
      if (piece.type === "end") tokens = piece.tokens;
    }
  } catch (error) {
    const problem = error instanceof ModelError ? error.problem : "answer";
    return { check: { at, outcome: "failed", problem }, tokens };
  } finally {
    clearTimeout(firstWordTimer);
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
