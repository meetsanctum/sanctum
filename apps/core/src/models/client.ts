import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  ModelMessage,
  ModelProblem,
  ModelTokens,
  ModelTool,
  ModelToolCall,
} from "@meetsanctum/app-sdk";
import {
  APICallError,
  jsonSchema,
  RetryError,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type ToolSet,
} from "ai";

import { conversationOf, keep, type KeptAnswers } from "./conversation.js";

// Every source is asked through the AI SDK: Anthropic's own provider for
// Claude, OpenAI's for OpenAI, and the OpenAI-compatible one for OpenRouter
// and Ollama. The core passes its own fetch, so each source is reached only
// at its own address, without redirects, and answers stay bounded. The
// answer comes back as the pieces apps read: text as it comes, each tool
// call whole, then one end with why it stopped and the tokens counted.

export type ModelPiece =
  | { type: "text"; text: string }
  | ({ type: "tool" } & ModelToolCall)
  | {
      type: "end";
      stop: "done" | "tool" | "limit" | "unavailable";
      tokens: ModelTokens;
    };

export type ModelRequest = {
  model: string;
  messages: readonly ModelMessage[];
  tools?: readonly ModelTool[];
  maxTokens: number;
};

/** Which of the SDK's providers reaches a source. */
export type ModelApi = "anthropic" | "openai" | "compatible";

/** Where a source answers, and how. */
export type ModelEndpoint = {
  api: ModelApi;
  // Ends without a slash, such as http://192.168.1.40:11434/v1.
  baseUrl: string;
  key?: string;
  fetch: typeof fetch;
};

/** Why a source gave no answer. */
export class ModelError extends Error {
  constructor(
    readonly problem: ModelProblem,
    message: string = problem,
  ) {
    super(message);
  }
}

/** The problem an answer's HTTP status means. */
export function problemOfStatus(status: number): ModelProblem {
  if (status === 401 || status === 403) return "key";
  if (status === 404) return "model";
  if (status >= 400 && status < 500) return "refused";
  return "answer";
}

const isTimeout = (reason: unknown) =>
  reason instanceof DOMException && reason.name === "TimeoutError";

/**
 * The problem a failed request means: none answered, too late, a status
 * that says why, or an answer that made no sense.
 */
export function problemOfError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) {
    const reason = signal.reason as unknown;
    if (reason instanceof ModelError) return reason;
    return new ModelError(isTimeout(reason) ? "timeout" : "unreachable");
  }
  // The SDK wraps what went wrong, the core's own errors among them, such as
  // an answer too large.
  const chain: unknown[] = [];
  for (let each = error; each && chain.length < 16;) {
    chain.push(each);
    if (!(each instanceof Error)) break;
    each = RetryError.isInstance(each) ? each.lastError : each.cause;
  }
  const own = chain.find((each) => each instanceof ModelError);
  if (own) return own as ModelError;
  for (const cause of chain) {
    if (isTimeout(cause)) return new ModelError("timeout");
    if (APICallError.isInstance(cause)) {
      return cause.statusCode === undefined
        ? new ModelError("unreachable")
        : new ModelError(
            problemOfStatus(cause.statusCode),
            `the source answered ${cause.statusCode}`,
          );
    }
    // What a failed connection throws.
    if (cause instanceof TypeError) return new ModelError("unreachable");
  }
  return new ModelError("answer", "the source's answer made no sense");
}

// Providers enforce their token limits. Bound the bytes the core reads too:
// each streamed piece carries a few hundred bytes around a token or two, so
// a whole answer of 4,096 tokens can pass 1 MiB.
export const maxResponseBytes = 8 * 1024 * 1024;

/**
 * Never follow redirects, which would carry the key to another host. Share
 * one byte budget across the requests for an answer or a model list.
 */
export function boundedFetch(fetcher: typeof fetch): typeof fetch {
  let size = 0;
  return async (input, init) => {
    const response = await fetcher(input, { ...init, redirect: "error" });
    if (!response.body) return response;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(bytes, controller) {
          size += bytes.byteLength;
          if (size > maxResponseBytes) {
            controller.error(
              new ModelError("answer", "the source's answer was too large"),
            );
          } else {
            controller.enqueue(bytes);
          }
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function languageModel(
  endpoint: ModelEndpoint,
  model: string,
  rejectToolOverflow: () => never,
): LanguageModel {
  // The base address and key are always given, so neither comes from the
  // environment, such as ANTHROPIC_BASE_URL or OPENAI_API_KEY.
  const settings = {
    baseURL: endpoint.baseUrl,
    apiKey: endpoint.key ?? "",
    fetch: boundedFetch(endpoint.fetch),
  };
  switch (endpoint.api) {
    case "anthropic":
      return createAnthropic(settings)(model);
    case "openai":
      return createOpenAI(settings)(model);
    case "compatible":
      // Ollama takes no key; the compatible provider sends none without one.
      return createOpenAICompatible({
        ...settings,
        apiKey: endpoint.key,
        name: "compatible",
        includeUsage: true,
        metadataExtractor: {
          extractMetadata: async () => undefined,
          createStreamExtractor: () => ({
            // The provider reads each piece of the stream here before its
            // tool-call tracker, whose work grows with the calls in one
            // piece: thousands in one piece would hold the core for a
            // minute.
            processChunk(chunk: unknown) {
              const choices = (chunk as { choices?: unknown } | null)?.choices;
              if (!Array.isArray(choices)) return;
              const calls = (
                choices[0] as { delta?: { tool_calls?: unknown } } | undefined
              )?.delta?.tool_calls;
              if (Array.isArray(calls) && calls.length > maxToolCalls) {
                rejectToolOverflow();
              }
            },
            buildMetadata: () => undefined,
          }),
        },
      }).chatModel(model);
  }
}

function toolsOf(tools: readonly ModelTool[] | undefined): ToolSet | undefined {
  if (!tools?.length) return undefined;
  // No `execute`: the SDK hands each call back, and the app runs it.
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchema({ type: "object", ...tool.input }),
      },
    ]),
  );
}

export type AskOptions = {
  signal: AbortSignal;
  /** How long until the first piece, thinking included. */
  firstPieceMs: number;
  /** How long the whole answer may take. */
  wholeMs?: number;
  onFirstPiece?: () => void;
  /** Answers of this turn that called a tool, to give back as they came. */
  kept?: KeptAnswers;
};

// Real answers call a handful of tools. Tracking each streamed call costs
// more the more calls an answer has, so a malformed stream of thousands
// could keep the core busy for seconds.
export const maxToolCalls = 64;

function stopOf(
  reason: string,
  calledTool: boolean,
): "done" | "tool" | "limit" | "unavailable" {
  switch (reason) {
    case "stop":
    case "tool-calls":
      // Some sources, Ollama among them, say "stop" with tool calls.
      return calledTool ? "tool" : "done";
    case "length":
      return "limit";
    case "content-filter":
      return "unavailable";
    default:
      throw new ModelError("answer", "the source didn't complete the answer");
  }
}

function tokensOf(usage: LanguageModelUsage, api: ModelApi): ModelTokens {
  const read = usage.inputTokens ?? 0;
  const written = usage.outputTokens ?? 0;
  const counts = [read, written, read + written];
  if (api === "anthropic") {
    // Claude's read total includes cache counts. A bad count can't be
    // allowed to cancel out a good one.
    const { noCacheTokens, cacheReadTokens, cacheWriteTokens } =
      usage.inputTokenDetails;
    counts.push(
      noCacheTokens ?? 0,
      cacheReadTokens ?? 0,
      cacheWriteTokens ?? 0,
    );
  }
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new ModelError("answer", "invalid token counts");
  }
  return { read, written };
}

/**
 * Asks a source and yields the answer in pieces, ending with one `end`.
 * Throws a ModelError when the source can't be reached, refuses, or its
 * answer breaks off.
 */
export async function* ask(
  endpoint: ModelEndpoint,
  request: ModelRequest,
  options: AskOptions,
): AsyncGenerator<ModelPiece> {
  const tools = toolsOf(request.tools);
  const asked = conversationOf(request.messages, request.tools, options.kept);
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let firstTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(new ModelError("timeout")),
    options.firstPieceMs,
  );
  function firstPiece() {
    if (firstTimer === undefined) return;
    clearTimeout(firstTimer);
    firstTimer = undefined;
    options.onFirstPiece?.();
  }
  function rejectToolOverflow(): never {
    const error = new ModelError("answer", "too many tool calls");
    controller.abort(error);
    throw error;
  }
  let toolCount = 0;
  function countToolCall() {
    if (++toolCount > maxToolCalls) rejectToolOverflow();
  }

  try {
    const result = streamText({
      model: languageModel(endpoint, request.model, rejectToolOverflow),
      instructions: asked.instructions,
      messages: asked.messages,
      ...(tools ? { tools } : {}),
      maxOutputTokens: request.maxTokens,
      abortSignal: signal,
      ...(options.wholeMs ? { timeout: { totalMs: options.wholeMs } } : {}),
      providerOptions: {
        // The tools and the start of the conversation stay the same from one
        // answer to the next, so Anthropic reuses them.
        anthropic: { cacheControl: { type: "ephemeral" } },
        // OpenAI keeps nothing; a reasoning model's reasoning comes back
        // sealed for the next answer instead.
        openai: { store: false },
      },
      // The stream's error part reaches the core; the SDK's default would
      // print the error with the whole conversation in it.
      onError: () => {},
      telemetry: { isEnabled: false },
    });
    const calls: ModelToolCall[] = [];
    const started = new Set<string>();
    let isBroken = false;
    let end: Extract<ModelPiece, { type: "end" }> | undefined;
    for await (const part of result.stream) {
      switch (part.type) {
        case "tool-input-start":
          countToolCall();
          started.add(part.id);
          firstPiece();
          break;
        case "reasoning-delta":
          // Thinking counts as the start of an answer: the model is
          // answering.
          firstPiece();
          break;
        case "text-delta":
          if (part.text) {
            firstPiece();
            yield { type: "text", text: part.text };
          }
          break;
        case "tool-call": {
          // Some providers send a call whole, without a start.
          if (!started.has(part.toolCallId)) countToolCall();
          firstPiece();
          // Input that isn't whole JSON, a tool the app didn't offer, or one
          // the provider ran itself: no app's tool runs on it.
          if (part.invalid || part.providerExecuted) {
            isBroken = true;
            break;
          }
          calls.push({
            id: part.toolCallId,
            name: part.toolName,
            input: part.input,
          });
          break;
        }
        case "error":
          throw part.error;
        case "abort":
          throw new DOMException("timed out", "TimeoutError");
        case "finish":
          end = {
            type: "end",
            stop: stopOf(part.finishReason, calls.length > 0),
            tokens: tokensOf(part.totalUsage, endpoint.api),
          };
          break;
      }
    }
    clearTimeout(firstTimer);
    if (!end) throw new ModelError("answer", "the answer broke off");
    if (end.stop !== "unavailable") {
      // A call cut off by the token limit is left out. The SDK's saved
      // answer may still contain it, so replay only what the app saw.
      if (isBroken && end.stop !== "limit") {
        throw new ModelError("answer", "a tool call isn't whole");
      }
      if (!isBroken && calls.length > 0 && options.kept) {
        keep(options.kept, asked, calls, await result.responseMessages);
      }
      for (const call of calls) yield { type: "tool", ...call };
    }
    yield end;
  } catch (error) {
    throw problemOfError(error, signal);
  } finally {
    clearTimeout(firstTimer);
  }
}
