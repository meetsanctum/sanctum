import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  StopReason,
  Tool,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { ModelChoice, ModelMessage } from "@meetsanctum/app-sdk";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

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

export type AnthropicEndpoint = {
  api: "anthropic";
  baseUrl: string;
  key: string;
  fetch: typeof fetch;
};

/** Each answer of this turn that called a tool, as it came, by call id. */
export type KeptAnswers = Map<
  string,
  {
    system: string | undefined;
    tools: Tool[] | undefined;
    messages: MessageParam[];
    visible: ContentBlockParam[];
    content: ContentBlockParam[];
  }
>;

// One byte budget for each answer or model lookup, including all its pages.
function boundedFetch(endpoint: AnthropicEndpoint): typeof fetch {
  let size = 0;
  return async (input, init) => {
    // Build the API headers here so the SDK's environment headers stay local.
    const response = await endpoint.fetch(input, {
      ...init,
      headers: {
        authorization: `Bearer ${endpoint.key}`,
        "anthropic-version": "2026-10-21",
        ...(init?.body == null ? {} : { "content-type": "application/json" }),
      },
      redirect: "error",
    });
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

function clientOf(endpoint: AnthropicEndpoint) {
  return new Anthropic({
    apiKey: endpoint.key,
    baseURL: endpoint.baseUrl,
    fetch: boundedFetch(endpoint),
    logLevel: "off",
    openTelemetry: false,
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

const continueDraft: MessageParam = {
  role: "user",
  content: "Please continue the assistant's draft.",
};

function endsWithDraft(messages: readonly MessageParam[]) {
  const last = messages.at(-1);
  return (
    last?.role === "assistant" &&
    Array.isArray(last.content) &&
    last.content.every((block) => block.type === "text")
  );
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
  tools?: Tool[],
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
      const [first] = message.toolCalls ?? [];
      const answered = first && kept?.get(first.id);
      const continued =
        answered &&
        answered.messages.length === wire.length + 1 &&
        endsWithDraft(wire);
      // A thinking block is tied to the conversation that produced it. If
      // the app edits that conversation, send the app's version on its own.
      if (
        answered &&
        answered.system === (system.join("\n\n") || undefined) &&
        isDeepStrictEqual(answered.tools, tools) &&
        isDeepStrictEqual(
          answered.messages,
          continued ? [...wire, continueDraft] : wire,
        ) &&
        isDeepStrictEqual(answered.visible, content)
      ) {
        // Restore the prompt that accompanied a draft when Claude answered it.
        if (continued) wire.push(continueDraft);
        wire.push({ role: "assistant", content: answered.content });
      } else if (content.length > 0) {
        wire.push({ role: "assistant", content });
      }
      continue;
    }
    if (message.content) wire.push({ role: "user", content: message.content });
  }
  return {
    system: system.join("\n\n") || undefined,
    messages: wire,
  };
}

function stopOf(reason: StopReason | null | undefined, calledTool: boolean) {
  switch (reason) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return "limit" as const;
    case "refusal":
      return "unavailable" as const;
    case null:
    case undefined:
      throw new ModelError("answer", "the answer broke off");
    case "tool_use":
      return "tool" as const;
    default:
      return calledTool ? ("tool" as const) : ("done" as const);
  }
}

const tokenCount = z.int().nonnegative();
const tokenUsage = z.object({
  input_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount.nullish(),
  cache_read_input_tokens: tokenCount.nullish(),
  output_tokens: tokenCount,
});

/**
 * Asks Claude and yields the answer in pieces, ending with one `end`.
 * Throws a ModelError when Anthropic can't be reached or the answer breaks off.
 */
export async function* anthropicChat(
  endpoint: AnthropicEndpoint,
  request: ModelRequest & { kept?: KeptAnswers },
  signal: AbortSignal,
  onFirstPiece?: () => void,
): AsyncGenerator<ModelPiece> {
  const tools: Tool[] | undefined = request.tools?.length
    ? request.tools.map((tool) => {
        const { type = "object" } = tool.input;
        if (type !== "object") {
          throw new ModelError(
            "answer",
            "Claude's tools require object inputs",
          );
        }
        return {
          name: tool.name,
          description: tool.description,
          input_schema: { ...tool.input, type },
        };
      })
    : undefined;
  const { system, messages: history } = messagesOf(
    request.messages,
    request.kept,
    tools,
  );
  const toolInputs = new Map<number, { json: string; isClosed: boolean }>();
  function firstPiece() {
    onFirstPiece?.();
    onFirstPiece = undefined;
  }
  const client = clientOf(endpoint);
  let messages = history;
  let final;
  for (;;) {
    try {
      const stream = client.messages.stream(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          system,
          messages,
          tools,
          // The tools and the start of the conversation stay the same from one
          // answer to the next, so Anthropic reuses them.
          cache_control: { type: "ephemeral" },
        },
        { signal },
      );
      for await (const event of stream) {
        // Thinking counts as the start of an answer: Claude is answering.
        if (event.type === "content_block_start") {
          firstPiece();
          if (event.content_block.type === "tool_use") {
            toolInputs.set(event.index, { json: "", isClosed: false });
          }
          if (event.content_block.type === "text" && event.content_block.text) {
            yield { type: "text", text: event.content_block.text };
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta" && event.delta.text) {
            yield { type: "text", text: event.delta.text };
          }
          if (event.delta.type === "input_json_delta") {
            const input = toolInputs.get(event.index);
            if (input) input.json += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          const input = toolInputs.get(event.index);
          if (input) input.isClosed = true;
        }
      }
      final = await stream.finalMessage();
      break;
    } catch (error) {
      // Some models reject a draft as the last message before streaming starts.
      if (
        !signal.aborted &&
        messages === history &&
        endsWithDraft(history) &&
        error instanceof APIError &&
        error.status === 400 &&
        error.type === "invalid_request_error" &&
        error.message.includes("does not support assistant message prefill")
      ) {
        messages = [...history, continueDraft];
        continue;
      }
      throw problemOf(error, signal);
    }
  }

  const stop = stopOf(
    final.stop_reason,
    final.content.some((block) => block.type === "tool_use"),
  );
  const usage = tokenUsage.safeParse(final.usage);
  if (!usage.success) throw new ModelError("answer", "invalid token counts");
  const {
    input_tokens: inputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
    output_tokens: outputTokens,
  } = usage.data;
  const read =
    inputTokens + (cacheCreationTokens ?? 0) + (cacheReadTokens ?? 0);
  if (!Number.isSafeInteger(read + outputTokens)) {
    throw new ModelError("answer", "invalid token counts");
  }
  if (stop === "tool") {
    const calls = final.content.flatMap((block, index) => {
      if (block.type !== "tool_use") return [];
      const received = toolInputs.get(index);
      // The SDK uses a partial parser, which can fill in missing JSON.
      // Only hand a complete object to a tool that can act on it.
      let input: unknown;
      try {
        if (received?.isClosed) {
          input = received.json ? JSON.parse(received.json) : block.input;
        }
      } catch {
        throw new ModelError("answer", "a tool call's input isn't JSON");
      }
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new ModelError(
          "answer",
          "a tool call has no complete input object",
        );
      }
      return [
        { type: "tool_use" as const, id: block.id, name: block.name, input },
      ];
    });
    const [first] = calls;
    if (!first) throw new ModelError("answer", "the source sent no tool call");
    if (request.kept) {
      const text = final.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      request.kept.set(first.id, {
        system,
        tools,
        messages,
        visible: text ? [{ type: "text", text }, ...calls] : calls,
        content: final.content,
      });
    }
    for (const call of calls) {
      yield { type: "tool", id: call.id, name: call.name, input: call.input };
    }
  }
  yield {
    type: "end",
    stop,
    tokens: { read, written: outputTokens },
  };
}

const modelList = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1).max(256),
      display_name: z.string().optional(),
    }),
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().min(1).nullish(),
});

/** The models a key may use, for the household to choose from. */
export async function anthropicModels(
  endpoint: AnthropicEndpoint,
  signal?: AbortSignal,
): Promise<ModelChoice[]> {
  const timeout = AbortSignal.timeout(10_000);
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const models: ModelChoice[] = [];
  try {
    const client = clientOf(endpoint);
    const seen = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const page = modelList.safeParse(
        await client.get<unknown>("/v1/models", {
          query: { limit: 1000, after_id: after },
          signal: both,
        }),
      );
      if (!page.success) throw new ModelError("answer", "not a model list");
      for (const model of page.data.data) {
        models.push({ id: model.id, name: model.display_name || model.id });
      }
      if (!page.data.has_more) break;
      const next = page.data.last_id;
      if (!next || seen.has(next)) {
        throw new ModelError("answer", "the model list did not advance");
      }
      seen.add(next);
      after = next;
    }
  } catch (error) {
    const problem = problemOf(error, both);
    // A key that opens nothing is the key's problem; anything else wrong
    // with the list is the answer's.
    throw problem.problem === "model" ? new ModelError("answer") : problem;
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}
