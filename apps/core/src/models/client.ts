import type {
  ModelMessage,
  ModelProblem,
  ModelTokens,
  ModelTool,
  ModelToolCall,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

// The client for OpenAI's chat completions, which Ollama, OpenAI and
// OpenRouter all answer: it streams an answer as server-sent events and
// turns them into pieces, text as it comes and each tool call once its
// input is whole, then one end with why it stopped and the tokens counted.
// Messages and tools pass through unchanged, in the order given, so a source
// that caches the start of a prompt can reuse it.

export type ModelPiece =
  | { type: "text"; text: string }
  | ({ type: "tool" } & ModelToolCall)
  | { type: "end"; stop: "done" | "tool" | "limit"; tokens: ModelTokens };

export type ModelRequest = {
  model: string;
  messages: readonly ModelMessage[];
  tools?: readonly ModelTool[];
  maxTokens: number;
};

/** Where a source answers, and how. */
export type ModelEndpoint = {
  // Ends without a slash, such as http://192.168.1.40:11434/v1.
  baseUrl: string;
  key?: string;
  fetch: typeof fetch;
  // OpenAI's newer models take max_completion_tokens instead.
  maxTokensField: "max_tokens" | "max_completion_tokens";
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

/** The problem a failed fetch means: none answered, or too late. */
export function problemOfError(error: unknown, signal: AbortSignal) {
  if (error instanceof ModelError) return error;
  if (signal.aborted) {
    const reason = signal.reason as unknown;
    if (reason instanceof ModelError) return reason;
    return new ModelError(
      reason instanceof DOMException && reason.name === "TimeoutError"
        ? "timeout"
        : "unreachable",
    );
  }
  return new ModelError("unreachable");
}

function wireMessage(message: ModelMessage) {
  switch (message.role) {
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(
                    call.input === undefined ? {} : call.input,
                  ),
                },
              })),
            }
          : {}),
      };
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    default:
      return { role: message.role, content: message.content };
  }
}

const toolDelta = z.object({
  index: z.int().nonnegative().optional(),
  id: z.string().nullish(),
  function: z
    .object({ name: z.string().nullish(), arguments: z.string().nullish() })
    .nullish(),
});

const streamChunk = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z.array(toolDelta).nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  usage: z
    .object({
      prompt_tokens: z.int().nonnegative().nullish(),
      completion_tokens: z.int().nonnegative().nullish(),
    })
    .nullish(),
  error: z.unknown().optional(),
});

// Providers enforce their token limits. Bound the bytes the core reads too,
// including unfinished lines and tool arguments spread across many chunks.
// Each streamed piece from a provider carries a few hundred bytes around a
// token or two, so a whole answer of 4,096 tokens can pass 1 MiB.
export const maxResponseBytes = 8 * 1024 * 1024;

/** The lines of an event stream's data, one JSON chunk or [DONE] each. */
async function* dataLines(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let rest = "";
  let size = 0;
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    size += bytes.byteLength;
    if (size > maxResponseBytes) {
      throw new ModelError("answer", "the source's answer was too large");
    }
    rest += decoder.decode(bytes, { stream: true });
    let end: number;
    while ((end = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, end).replace(/\r$/, "");
      rest = rest.slice(end + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  rest += decoder.decode();
  if (rest.startsWith("data:")) yield rest.slice(5).trim();
}

/**
 * Asks the source and yields the answer in pieces, ending with one `end`.
 * Throws a ModelError when the source can't be reached, refuses, or its
 * answer breaks off.
 */
export async function* chat(
  endpoint: ModelEndpoint,
  request: ModelRequest,
  signal: AbortSignal,
  onFirstPiece?: () => void,
): AsyncGenerator<ModelPiece> {
  let response: Response;
  try {
    response = await endpoint.fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(endpoint.key ? { authorization: `Bearer ${endpoint.key}` } : {}),
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(wireMessage),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.input,
                },
              })),
            }
          : {}),
        [endpoint.maxTokensField]: request.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      redirect: "error",
      signal,
    });
  } catch (error) {
    throw problemOfError(error, signal);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new ModelError(
      problemOfStatus(response.status),
      `the source answered ${response.status}`,
    );
  }

  const calls = new Map<number, { id: string; name: string; args: string }>();
  let stop: "done" | "tool" | "limit" | undefined;
  const tokens: ModelTokens = { read: 0, written: 0 };
  let finished = false;
  try {
    for await (const data of dataLines(response.body)) {
      if (!data) continue;
      if (data === "[DONE]") {
        finished = true;
        break;
      }
      let chunk: z.infer<typeof streamChunk>;
      try {
        chunk = streamChunk.parse(JSON.parse(data));
      } catch {
        throw new ModelError("answer", "the source sent a broken piece");
      }
      if (chunk.error) {
        throw new ModelError("answer", "the source stopped with an error");
      }
      if (chunk.usage) {
        tokens.read = chunk.usage.prompt_tokens ?? tokens.read;
        tokens.written = chunk.usage.completion_tokens ?? tokens.written;
      }
      for (const choice of chunk.choices ?? []) {
        const text = choice.delta?.content;
        const toolCalls = choice.delta?.tool_calls ?? [];
        if (text || toolCalls.length > 0) {
          onFirstPiece?.();
          onFirstPiece = undefined;
        }
        if (text) yield { type: "text", text };
        for (const call of toolCalls) {
          const index = call.index ?? 0;
          const kept = calls.get(index) ?? { id: "", name: "", args: "" };
          kept.id ||= call.id ?? "";
          kept.name += call.function?.name ?? "";
          kept.args += call.function?.arguments ?? "";
          calls.set(index, kept);
        }
        if (choice.finish_reason) {
          if (
            choice.finish_reason === "error" ||
            choice.finish_reason === "content_filter"
          ) {
            throw new ModelError(
              "answer",
              "the source didn't complete the answer",
            );
          }
          stop =
            choice.finish_reason === "length"
              ? "limit"
              : choice.finish_reason === "tool_calls" || calls.size > 0
                ? "tool"
                : "done";
        }
      }
    }
  } catch (error) {
    throw problemOfError(error, signal);
  }
  if (!finished && stop === undefined) {
    throw new ModelError("answer", "the answer broke off");
  }
  for (const [index, call] of [...calls].sort(([a], [b]) => a - b)) {
    let input: unknown;
    try {
      input = JSON.parse(call.args);
    } catch {
      if (stop === "limit") continue;
      throw new ModelError("answer", "a tool call's input isn't JSON");
    }
    if (!call.name) {
      if (stop === "limit") continue;
      throw new ModelError("answer", "a tool call has no name");
    }
    yield {
      type: "tool",
      id: call.id || `call-${index}`,
      name: call.name,
      input,
    };
  }
  yield {
    type: "end",
    stop: stop ?? (calls.size > 0 ? "tool" : "done"),
    tokens,
  };
}
