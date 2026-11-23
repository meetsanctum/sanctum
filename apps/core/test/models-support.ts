import type { ModelFetchers } from "../src/models/endpoints.js";

// Fake AI model sources for tests: Ollama on a computer in the home, and
// OpenRouter and Anthropic on the internet, answering as the real ones do,
// with an answer streamed as server-sent events.

/** What a fake source answers to a chat. */
export type FakeAnswer = {
  // The text it writes, in pieces.
  text?: string[];
  // Whether it calls the tool it was given.
  callsTool?: boolean;
  toolArguments?: string;
  tokens?: { read: number; written: number };
  // How long it waits before the first piece.
  delayMs?: number;
  // It sends its first piece of text, then nothing until it's stopped.
  hangs?: boolean;
  // Anthropic's only: it thinks first, and why it stops instead of the
  // usual end of a turn or a tool call.
  thinks?: boolean;
  stopReason?: string;
};

export type FakeSources = {
  fetchers: ModelFetchers;
  // What each source answers, which a test can change.
  ollama: {
    up: boolean;
    models: { name: string; size: number; remote_host?: string }[];
    answer: FakeAnswer;
  };
  openRouter: { key: string; answer: FakeAnswer };
  anthropic: { key: string; answer: FakeAnswer };
  // Every request, as method and URL, with the authorization it carried.
  requests: { method: string; url: string; authorization?: string }[];
  // Each chat's body as sent.
  chats: Record<string, unknown>[];
  // How many answers that hung were stopped by the core.
  stopped: number;
};

export const officeMac = "192.168.1.40";
/** Where the manager's Ollama on Sanctum answers, as it gives the core. */
export const sanctumOllama = "http://sanctum-ollama:11434";

const encoder = new TextEncoder();

function hanging(
  answer: FakeAnswer,
  signal: AbortSignal | null | undefined,
  sources: FakeSources,
) {
  const first = JSON.stringify({
    choices: [{ delta: { content: answer.text?.[0] ?? "It's " } }],
  });
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${first}\n\n`));
      signal?.addEventListener("abort", () => {
        sources.stopped += 1;
        controller.error(signal.reason);
      });
    },
  });
}

function events(answer: FakeAnswer, signal?: AbortSignal | null) {
  const chunks: string[] = [];
  for (const text of answer.text ?? ["It's ", "noon."]) {
    chunks.push(JSON.stringify({ choices: [{ delta: { content: text } }] }));
  }
  if (answer.callsTool) {
    // The call's name and input come in pieces, as they do.
    chunks.push(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  function: { name: "get_", arguments: "" },
                },
              ],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    name: "time",
                    arguments: answer.toolArguments ?? "{}",
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  }
  chunks.push(
    JSON.stringify({
      choices: [
        { delta: {}, finish_reason: answer.callsTool ? "tool_calls" : "stop" },
      ],
    }),
    JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: answer.tokens?.read ?? 40,
        completion_tokens: answer.tokens?.written ?? 6,
      },
    }),
    "[DONE]",
  );
  // Split across reads mid-line, as a network does.
  const text = chunks.map((chunk) => `data: ${chunk}\n\n`).join("");
  const parts = [text.slice(0, 17), text.slice(17, 60), text.slice(60)];
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (answer.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
      }
      if (signal?.aborted) {
        controller.error(signal.reason);
        return;
      }
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

// Anthropic's stream: the message, then each block opened, filled and
// closed, then why it stopped with what it wrote.
function anthropicEvents(answer: FakeAnswer, tool: string) {
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: answer.tokens?.read ?? 30,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 10,
            output_tokens: 1,
          },
        },
      },
    ],
  ];
  let index = 0;
  const block = (start: unknown, deltas: unknown[]) => {
    events.push([
      "content_block_start",
      { type: "content_block_start", index, content_block: start },
    ]);
    for (const delta of deltas) {
      events.push([
        "content_block_delta",
        { type: "content_block_delta", index, delta },
      ]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
    index += 1;
  };
  if (answer.thinks) {
    block({ type: "thinking", thinking: "", signature: "" }, [
      { type: "signature_delta", signature: "sig-thought-1" },
    ]);
  }
  block(
    { type: "text", text: "" },
    (answer.text ?? ["It's ", "noon."]).map((text) => ({
      type: "text_delta",
      text,
    })),
  );
  if (answer.callsTool) {
    const input = answer.toolArguments ?? "{}";
    block({ type: "tool_use", id: "toolu_1", name: tool, input: {} }, [
      { type: "input_json_delta", partial_json: input.slice(0, 1) },
      { type: "input_json_delta", partial_json: input.slice(1) },
    ]);
  }
  events.push(
    [
      "message_delta",
      {
        type: "message_delta",
        delta: {
          stop_reason:
            answer.stopReason ?? (answer.callsTool ? "tool_use" : "end_turn"),
          stop_sequence: null,
        },
        usage: { output_tokens: answer.tokens?.written ?? 8 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  );
  const text = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const unreachable = () => Promise.reject(new TypeError("fetch failed"));

export function fakeSources(): FakeSources {
  const sources: FakeSources = {
    ollama: {
      up: true,
      models: [
        { name: "qwen3:8b", size: 5_200_000_000 },
        { name: "llama3.2:3b", size: 2_000_000_000 },
      ],
      answer: { callsTool: true },
    },
    openRouter: { key: "sk-or-v1-test-key-4f2a", answer: { callsTool: true } },
    anthropic: {
      key: "sk-ant-api03-test-key-7c1d",
      answer: { callsTool: true },
    },
    requests: [],
    chats: [],
    stopped: 0,
    fetchers: {
      async home(input, init) {
        const url = new URL(String(input));
        note(url, init);
        // The same fake Ollama answers on a computer and on Sanctum.
        const isOllama =
          url.host === `${officeMac}:11434` || url.origin === sanctumOllama;
        if (!isOllama || !sources.ollama.up) return unreachable();
        if (url.pathname === "/api/generate") {
          sources.chats.push(JSON.parse(String(init?.body)));
          return json({ done: true });
        }
        if (url.pathname === "/api/tags") {
          return json({ models: sources.ollama.models });
        }
        if (url.pathname === "/v1/chat/completions") {
          sources.chats.push(JSON.parse(String(init?.body)));
          const { answer } = sources.ollama;
          const body = answer.hangs
            ? hanging(answer, init?.signal, sources)
            : events(answer, init?.signal);
          return new Response(body, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return json({ error: "not found" }, 404);
      },
      async internet(input, init) {
        const url = new URL(String(input));
        note(url, init);
        if (url.host === "api.anthropic.com") return anthropic(url, init);
        if (url.host !== "openrouter.ai") return unreachable();
        const authorized =
          headerOf(init, "authorization") ===
          `Bearer ${sources.openRouter.key}`;
        if (url.pathname === "/api/v1/key") {
          return authorized ? json({ data: {} }) : json({ error: "no" }, 401);
        }
        if (url.pathname === "/api/v1/models") {
          return json({
            data: [
              { id: "openai/gpt-5-mini", name: "OpenAI: GPT-5 Mini" },
              {
                id: "anthropic/claude-haiku-4.5",
                name: "Anthropic: Claude Haiku 4.5",
              },
            ],
          });
        }
        if (url.pathname === "/api/v1/chat/completions") {
          if (!authorized) return json({ error: "no" }, 401);
          sources.chats.push(JSON.parse(String(init?.body)));
          return new Response(events(sources.openRouter.answer, init?.signal), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return json({ error: "not found" }, 404);
      },
    },
  };
  async function anthropic(url: URL, init?: RequestInit) {
    // Anthropic takes a key in either header; its SDK sends it as a bearer.
    const key =
      headerOf(init, "x-api-key") ??
      headerOf(init, "authorization")?.replace(/^Bearer /, "");
    if (key !== sources.anthropic.key) {
      return json(
        {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        },
        401,
      );
    }
    if (url.pathname === "/v1/models") {
      return json({
        data: [
          {
            type: "model",
            id: "claude-sonnet-5-5",
            display_name: "Claude Sonnet 5.5",
            created_at: "2026-10-01T00:00:00Z",
          },
          {
            type: "model",
            id: "claude-haiku-5-5",
            display_name: "Claude Haiku 5.5",
            created_at: "2026-10-01T00:00:00Z",
          },
        ],
        has_more: false,
        first_id: "claude-sonnet-5-5",
        last_id: "claude-haiku-5-5",
      });
    }
    if (url.pathname === "/v1/messages") {
      const body = JSON.parse(String(init?.body)) as {
        tools?: { name: string }[];
      };
      sources.chats.push(body);
      return new Response(
        anthropicEvents(
          sources.anthropic.answer,
          body.tools?.[0]?.name ?? "get_time",
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return json({ type: "error", error: { type: "not_found_error" } }, 404);
  }
  function note(url: URL, init?: RequestInit) {
    const authorization = headerOf(init, "authorization");
    sources.requests.push({
      method: init?.method ?? "GET",
      url: url.toString(),
      ...(authorization ? { authorization } : {}),
    });
  }
  return sources;
}

function headerOf(init: RequestInit | undefined, name: string) {
  const headers = new Headers(init?.headers);
  return headers.get(name) ?? undefined;
}
