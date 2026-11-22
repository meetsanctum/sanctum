import { describe, expect, it } from "vitest";

import {
  AddressProblem,
  isHomeAddress,
  parseAddress,
  resolveHomeAddress,
} from "../src/models/addresses.js";
import { chat, ModelError, type ModelPiece } from "../src/models/client.js";
import { ollamaModelName } from "../src/models/endpoints.js";

// The pieces of reaching a model: where a computer in the home may be, how
// an Ollama tag reads, and the client's reading of a streamed answer.

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
  });

  it("refuses a URL, a path or a port out of range", () => {
    for (const typed of [
      "http://192.168.1.40",
      "192.168.1.40/v1",
      "192.168.1.40:0",
      "192.168.1.40:70000",
      "user@192.168.1.40",
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
  const endpoint = (body: string, status = 200) => ({
    baseUrl: "http://192.168.1.40:11434/v1",
    maxTokensField: "max_tokens" as const,
    fetch: (async () =>
      new Response(body, {
        status,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch,
  });
  const ask = async (body: string, status?: number) => {
    const pieces: ModelPiece[] = [];
    for await (const piece of chat(
      endpoint(body, status),
      {
        model: "qwen3:8b",
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 64,
      },
      AbortSignal.timeout(5_000),
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

  it("names a key that's refused", async () => {
    const failed = ask("{}", 401).catch((error: unknown) => error);
    await expect(failed).resolves.toBeInstanceOf(ModelError);
    await expect(failed).resolves.toMatchObject({ problem: "key" });
  });
});
