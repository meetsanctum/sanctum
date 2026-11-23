import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  StopReason,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { ModelChoice, ModelMessage } from "@meetsanctum/app-sdk";

import {
  maxResponseBytes,
  ModelError,
  problemOfError,
  problemOfStatus,
  type ModelPiece,
  type ModelRequest,
} from "./client.js";

// Anthropic's own client, the Messages API through Anthropic's SDK, since
// its OpenAI-compatible layer isn't meant for production. It answers as the
// OpenAI-compatible client does: text as it comes, each tool call once its
// input is whole, then one end with why it stopped and the tokens counted.
//
// Claude thinks before it answers, and a tool loop has to give each answer
// back as it came, thinking included, or the model loses its reasoning. Apps
// give back only text and tool calls, so within a turn the core keeps each
// answer that called a tool, by its first call's id, and gives that instead.

export const anthropicBaseUrl = "https://api.anthropic.com";

/** Each answer of this turn that called a tool, as it came, by call id. */
export type KeptAnswers = Map<string, ContentBlockParam[]>;

// The SDK's fetch: the internet's, never following a redirect, and reading
// no more of an answer than the OpenAI-compatible client would.
function boundedFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, { ...init, redirect: "error" });
    if (!response.body) return response;
    let size = 0;
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

function clientOf(endpoint: {
  baseUrl: string;
  key?: string;
  fetch: typeof fetch;
}) {
  return new Anthropic({
    apiKey: endpoint.key ?? null,
    baseURL: endpoint.baseUrl,
    fetch: boundedFetch(endpoint.fetch),
    // The core's own caps decide how long an answer may take, and a source
    // that fails is tried again by whoever asked.
    maxRetries: 0,
  });
}

// What went wrong, as the problem Settings and turns name.
function problemOf(error: unknown, signal?: AbortSignal): ModelError {
  if (signal?.aborted) return problemOfError(error, signal);
  for (let cause = error; cause; cause = (cause as Error).cause) {
    if (cause instanceof ModelError) return cause;
    if (!(cause instanceof Error)) break;
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new ModelError("timeout");
  }
  if (error instanceof APIConnectionError) {
    return new ModelError("unreachable");
  }
  if (error instanceof APIError && error.status !== undefined) {
    return new ModelError(
      problemOfStatus(error.status),
      `the source answered ${error.status}`,
    );
  }
  return new ModelError("answer", "the source stopped with an error");
}

/**
 * The conversation as the Messages API takes it. System messages before the
 * first other one become the system prompt, and later ones the household's
 * words, since not every model takes them mid-conversation. Tool results
 * that follow each other go back in one message, as the model answered
 * them.
 */
export function messagesOf(
  messages: readonly ModelMessage[],
  kept?: KeptAnswers,
): { system: string | undefined; messages: MessageParam[] } {
  const system: string[] = [];
  const wire: MessageParam[] = [];
  let isStart = true;
  for (const message of messages) {
    if (message.role === "system" && isStart) {
      system.push(message.content);
      continue;
    }
    isStart = false;
    if (message.role === "tool") {
      const result: ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
      };
      const last = wire.at(-1);
      if (
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((block) => block.type === "tool_result")
      ) {
        last.content.push(result);
      } else {
        wire.push({ role: "user", content: [result] });
      }
      continue;
    }
    if (message.role === "assistant") {
      const [first] = message.toolCalls ?? [];
      const answered = first && kept?.get(first.id);
      if (answered) {
        wire.push({ role: "assistant", content: answered });
        continue;
      }
      const content: ContentBlockParam[] = [
        ...(message.content
          ? [{ type: "text" as const, text: message.content }]
          : []),
        ...(message.toolCalls ?? []).map((call) => ({
          type: "tool_use" as const,
          id: call.id,
          name: call.name,
          // Claude's tool calls take an object, as every tool's input is.
          input:
            typeof call.input === "object" &&
            call.input !== null &&
            !Array.isArray(call.input)
              ? call.input
              : {},
        })),
      ];
      if (content.length > 0) wire.push({ role: "assistant", content });
      continue;
    }
    if (message.content) wire.push({ role: "user", content: message.content });
  }
  return {
    system: system.length > 0 ? system.join("\n\n") : undefined,
    messages: wire,
  };
}

function stopOf(reason: StopReason | null, calledTool: boolean) {
  switch (reason) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return "limit" as const;
    case "refusal":
      throw new ModelError("answer", "the model declined to answer");
    case "tool_use":
      return "tool" as const;
    default:
      return calledTool ? ("tool" as const) : ("done" as const);
  }
}

/**
 * Asks Claude and yields the answer in pieces, ending with one `end`.
 * Throws a ModelError when Anthropic can't be reached, refuses, or the
 * answer breaks off.
 */
export async function* anthropicChat(
  endpoint: { baseUrl: string; key?: string; fetch: typeof fetch },
  request: ModelRequest & { kept?: KeptAnswers },
  signal: AbortSignal,
  onFirstPiece?: () => void,
): AsyncGenerator<ModelPiece> {
  const { system, messages } = messagesOf(request.messages, request.kept);
  let final;
  try {
    const stream = clientOf(endpoint).messages.stream(
      {
        model: request.model,
        max_tokens: request.maxTokens,
        ...(system ? { system } : {}),
        messages,
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: {
                  ...tool.input,
                  type: "object" as const,
                },
              })),
            }
          : {}),
        // The tools and the start of the conversation stay the same from one
        // answer to the next, so Anthropic reuses them.
        cache_control: { type: "ephemeral" },
      },
      { signal },
    );
    for await (const event of stream) {
      // Thinking counts as the start of an answer: Claude is answering.
      if (event.type === "content_block_start") {
        onFirstPiece?.();
        onFirstPiece = undefined;
      }
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta" &&
        event.delta.text
      ) {
        yield { type: "text", text: event.delta.text };
      }
    }
    final = await stream.finalMessage();
  } catch (error) {
    throw problemOf(error, signal);
  }

  const calls = final.content.filter((block) => block.type === "tool_use");
  const stop = stopOf(final.stop_reason, calls.length > 0);
  if (calls.length > 0 && stop === "tool") {
    request.kept?.set(calls[0]!.id, final.content as ContentBlockParam[]);
  }
  if (stop !== "limit") {
    for (const call of calls) {
      yield { type: "tool", id: call.id, name: call.name, input: call.input };
    }
  }
  const { usage } = final;
  yield {
    type: "end",
    stop,
    tokens: {
      read:
        usage.input_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
      written: usage.output_tokens,
    },
  };
}

/** The models a key may use, for the household to choose from. */
export async function anthropicModels(
  endpoint: { baseUrl: string; key: string; fetch: typeof fetch },
  signal?: AbortSignal,
): Promise<ModelChoice[]> {
  const timeout = AbortSignal.timeout(10_000);
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const models: ModelChoice[] = [];
  try {
    for await (const model of clientOf(endpoint).models.list(
      { limit: 1000 },
      { signal: both },
    )) {
      models.push({ id: model.id, name: model.display_name || model.id });
    }
  } catch (error) {
    const problem = problemOf(error, both);
    // A key that opens nothing is the key's problem; anything else wrong
    // with the list is the answer's.
    throw problem.problem === "model" ? new ModelError("answer") : problem;
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}
