import type { ModelFetchers } from "../src/models/endpoints.js";

// Fake AI model sources for tests: Ollama on a computer in the home and
// OpenRouter on the internet, answering as the real ones do, with an answer
// streamed as server-sent events.

/** What a fake source answers to a chat. */
export type FakeAnswer = {
  // The text it writes, in pieces.
  text?: string[];
  // Whether it calls the tool it was given.
  callsTool?: boolean;
  tokens?: { read: number; written: number };
  // How long it waits before the first piece.
  delayMs?: number;
  // It sends its first piece of text, then nothing until it's stopped.
  hangs?: boolean;
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
  // Every request, as method and URL, with the authorization it carried.
  requests: { method: string; url: string; authorization?: string }[];
  // Each chat's body as sent.
  chats: Record<string, unknown>[];
  // How many answers that hung were stopped by the core.
  stopped: number;
};

export const officeMac = "192.168.1.40";

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
                { index: 0, function: { name: "time", arguments: "{}" } },
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
    requests: [],
    chats: [],
    stopped: 0,
    fetchers: {
      async home(input, init) {
        const url = new URL(String(input));
        note(url, init);
        if (url.host !== `${officeMac}:11434` || !sources.ollama.up) {
          return unreachable();
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
