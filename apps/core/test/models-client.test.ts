import { describe, expect, it } from "vitest";

import {
  AddressProblem,
  isHomeAddress,
  parseAddress,
  resolveHomeAddress,
} from "../src/models/addresses.js";
import { checkSource } from "../src/models/check.js";
import {
  ask as askSource,
  ModelError,
  type ModelEndpoint,
  type ModelPiece,
} from "../src/models/client.js";
import { ollamaModelName } from "../src/models/endpoints.js";

// The pieces of reaching a model: where a computer in the home may be, how
// an Ollama tag reads, and how a streamed answer becomes pieces.

describe("a computer's address", () => {
  it("takes an address, a port and a name", () => {
    expect(parseAddress("192.168.1.40")).toEqual({
      name: "192.168.1.40",
      port: 11434,
    });
    expect(parseAddress(" 192.168.1.40:11500 ")).toEqual({
      name: "192.168.1.40",
      port: 11500,
    });
    expect(parseAddress("[fd00::5]:8080")).toEqual({
      name: "fd00::5",
      port: 8080,
    });
    expect(parseAddress("office-mac.local")).toEqual({
      name: "office-mac.local",
      port: 11434,
    });
    const name = [
      "a".repeat(63),
      "b".repeat(63),
      "c".repeat(63),
      "d".repeat(61),
    ].join(".");
    expect(parseAddress(`${name}:65535`)).toEqual({ name, port: 65535 });
  });

  it("refuses a URL, a path or a port out of range", () => {
    for (const typed of [
      "http://192.168.1.40",
      "192.168.1.40/v1",
      "192.168.1.40:0",
      "192.168.1.40:70000",
      "user@192.168.1.40",
      "[fd00::5%en0]",
      "",
    ]) {
      expect(() => parseAddress(typed), typed).toThrow(AddressProblem);
    }
  });

  it("is on the home's network only", () => {
    for (const address of [
      "10.0.0.2",
      "172.20.1.1",
      "192.168.1.40",
      "fd12::1",
    ]) {
      expect(isHomeAddress(address), address).toBe(true);
    }
    for (const address of [
      "8.8.8.8",
      "127.0.0.1",
      "::1",
      "100.64.0.1",
      "fe80::1",
      "fd00::5%en0",
    ]) {
      expect(isHomeAddress(address), address).toBe(false);
    }
  });

  it("takes a name's address in the home, once", async () => {
    await expect(
      resolveHomeAddress("office-mac.local", async () => [
        "8.8.8.8",
        "192.168.1.40",
      ]),
    ).resolves.toEqual({ host: "192.168.1.40", port: 11434 });
    await expect(
      resolveHomeAddress("example.com", async () => ["93.184.215.14"]),
    ).rejects.toMatchObject({ problem: "refused" });
    await expect(
      resolveHomeAddress("nowhere.local", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toMatchObject({ problem: "unreachable" });
  });
});

describe("Ollama's model names", () => {
  it("reads as people write them", () => {
    expect(ollamaModelName("qwen3:8b")).toBe("Qwen3 8B");
    expect(ollamaModelName("llama3.2:3b")).toBe("Llama3.2 3B");
    expect(ollamaModelName("gemma3:latest")).toBe("Gemma3");
    expect(ollamaModelName("gemma3:4b-it-qat")).toBe("Gemma3 4b-it-qat");
    expect(ollamaModelName("mistral")).toBe("Mistral");
  });
});

describe("the client", () => {
  const endpoint = (body: string, status = 200): ModelEndpoint => ({
    api: "compatible",
    baseUrl: "http://192.168.1.40:11434/v1",
    fetch: (async () =>
      new Response(body, {
        status,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch,
  });
  const ask = async (body: string, status?: number) => {
    const pieces: ModelPiece[] = [];
    for await (const piece of askSource(
      endpoint(body, status),
      {
        model: "qwen3:8b",
        messages: [{ role: "user", content: "Hi" }],
        tools: [
          {
            name: "lights",
            description: "Turns the lights on or off.",
            input: { type: "object", properties: { to: { type: "string" } } },
          },
        ],
        maxTokens: 64,
      },
      { signal: AbortSignal.timeout(5_000), firstPieceMs: 5_000 },
    )) {
      pieces.push(piece);
    }
    return pieces;
  };

  it("streams text, then each tool call whole, then the end", async () => {
    const pieces = await ask(
      [
        'data: {"choices":[{"delta":{"content":"Let me "}}]}',
        'data: {"choices":[{"delta":{"content":"look."}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"lights","arguments":"{\\"to\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"on\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":9}}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    );
    expect(pieces).toEqual([
      { type: "text", text: "Let me " },
      { type: "text", text: "look." },
      { type: "tool", id: "a", name: "lights", input: { to: "on" } },
      { type: "end", stop: "tool", tokens: { read: 120, written: 9 } },
    ]);
  });

  it("says an answer cut short by its limit", async () => {
    const pieces = await ask(
      'data: {"choices":[{"delta":{"content":"Once"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
    );
    expect(pieces.at(-1)).toMatchObject({ type: "end", stop: "limit" });
  });

  it("fails an answer that breaks off", async () => {
    await expect(
      ask('data: {"choices":[{"delta":{"content":"Once"}}]}\n\n'),
    ).rejects.toMatchObject({ problem: "answer" });
  });

  it("leaves out a tool call cut short by the token limit", async () => {
    const pieces = await ask(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"lights","arguments":"{"}}]},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
    );
    expect(pieces).toEqual([
      { type: "end", stop: "limit", tokens: { read: 0, written: 0 } },
    ]);
  });

  it("fails a tool call that isn't whole, or to a tool it wasn't given", async () => {
    for (const call of [
      '{"index":0,"id":"a","function":{"name":"lights","arguments":"{"}}',
      '{"index":0,"id":"a","function":{"name":"locks","arguments":"{}"}}',
    ]) {
      await expect(
        ask(
          `data: {"choices":[{"delta":{"tool_calls":[${call}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`,
        ),
      ).rejects.toMatchObject({ problem: "answer" });
    }
  });

  it("refuses malformed token usage, and ends a filtered answer as unavailable", async () => {
    await expect(
      ask(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: "40", completion_tokens: 6 } })}\n\ndata: [DONE]\n\n`,
      ),
    ).rejects.toMatchObject({ problem: "answer" });
    const filtered = await ask(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "content_filter" }] })}\n\ndata: [DONE]\n\n`,
    );
    expect(filtered.at(-1)).toMatchObject({ type: "end", stop: "unavailable" });
  });

  it("fails a check whose answer is empty or calls a tool it wasn't given", async () => {
    const check = (body: string) =>
      checkSource({
        endpoint: endpoint(body),
        model: "qwen3:8b",
        inHome: true,
        now: () => new Date(),
      });
    const empty = await check("data: [DONE]\n\n");
    expect(empty.check).toMatchObject({ outcome: "failed", problem: "answer" });
    const otherTool = await check(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"other","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
    );
    expect(otherTool.check).toMatchObject({
      outcome: "failed",
      problem: "answer",
    });
  });

  it("names a key that's refused", async () => {
    const failed = ask("{}", 401).catch((error: unknown) => error);
    await expect(failed).resolves.toBeInstanceOf(ModelError);
    await expect(failed).resolves.toMatchObject({ problem: "key" });
  });
});
