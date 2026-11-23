import { isActionError } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { createOllamaApp, type OllamaStatus } from "../src/index.js";
import { fakeContext, fakeOllama, piHost, run } from "./support.js";

// The Ollama app's actions: what its page reads, a model downloaded with its
// progress, a download stopped, and a model removed.

const gb = 1_000_000_000;

async function home(options: Parameters<typeof fakeContext>[1] = {}) {
  const { ollama, fetcher } = fakeOllama();
  const app = createOllamaApp({ fetch: fetcher });
  const { ctx, logs } = fakeContext(app, options);
  await app.start!(ctx, { reason: "added" });
  const status = async () =>
    (await run(app, ctx, "ollama.status")) as OllamaStatus;
  const act = (id: string, input: unknown) => run(app, ctx, id, input);
  return { app, ctx, logs, ollama, status, act };
}

async function refusal(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (isActionError(error)) return error.code;
    throw error;
  }
  return null;
}

describe("the Ollama app", () => {
  it("says what this Sanctum has and offers what fits, the suggested one marked", async () => {
    const { ollama, status } = await home();
    ollama.models = [{ name: "qwen3:8b", size: 5.2 * gb }];

    const shown = await status();

    expect(shown.isAnswering).toBe(true);
    expect(shown.host).toMatchObject({
      processor: { name: "Intel(R) N150", isLikelySlow: false },
      // The 8 GiB Ollama may take, as 9.8 GB are free.
      memory: { roomBytes: 8 * 1024 ** 3 },
    });
    expect(shown.models).toEqual([
      {
        id: "qwen3:8b",
        name: "Qwen3 8B",
        sizeBytes: 5.2 * gb,
        memoryBytes: 6.5 * gb,
      },
    ]);
    expect(shown.offered.map((model) => [model.id, model.isSuggested])).toEqual(
      [
        ["qwen3:1.7b", false],
        ["llama3.2:3b", false],
        ["qwen3:4b", true],
      ],
    );
  });

  it("leaves Ollama's cloud models out", async () => {
    const { ollama, status } = await home();
    ollama.models = [
      { name: "qwen3:4b", size: 2.5 * gb },
      { name: "gpt-oss:120b-cloud", size: 384 },
      { name: "remote", size: 384, remote_host: "https://ollama.com" },
    ];

    expect((await status()).models.map((model) => model.id)).toEqual([
      "qwen3:4b",
    ]);
  });

  it("downloads a model, saying how far it has come, until it's on Sanctum", async () => {
    const { ollama, status, act } = await home();

    await act("ollama.download", { model: "qwen3:1.7b" });
    await vi.waitFor(() => expect(ollama.pulls).toHaveLength(1));
    const [pull] = ollama.pulls;
    pull!.send({
      status: "pulling a1",
      digest: "sha256:a1",
      total: 1.3 * gb,
      completed: 0.5 * gb,
    });
    await vi.waitFor(async () =>
      expect((await status()).downloads).toMatchObject([
        { completedBytes: 0.5 * gb, totalBytes: 1.4 * gb },
      ]),
    );
    pull!.send({
      status: "pulling b2",
      digest: "sha256:b2",
      total: 0.1 * gb,
      completed: 0.1 * gb,
    });

    await vi.waitFor(async () =>
      expect((await status()).downloads).toMatchObject([
        {
          id: "qwen3:1.7b",
          name: "Qwen3 1.7B",
          completedBytes: 0.6 * gb,
          totalBytes: 1.4 * gb,
        },
      ]),
    );
    expect((await status()).offered.map((model) => model.id)).not.toContain(
      "qwen3:1.7b",
    );

    pull!.finish();
    await vi.waitFor(async () => {
      const shown = await status();
      expect(shown.downloads).toEqual([]);
      expect(shown.models.map((model) => model.id)).toEqual(["qwen3:1.7b"]);
    });
  });

  it("stops a download, and says why one failed", async () => {
    const { ollama, status, act } = await home();
    await act("ollama.download", { model: "qwen3:4b" });
    await vi.waitFor(() => expect(ollama.pulls).toHaveLength(1));

    await act("ollama.stop", { model: "qwen3:4b" });
    expect(ollama.pulls[0]!.aborted).toBe(true);
    expect((await status()).downloads).toEqual([]);

    await act("ollama.download", { model: "llama3.2:3b" });
    await vi.waitFor(() => expect(ollama.pulls).toHaveLength(2));
    ollama.pulls[1]!.send({
      error: "pull model manifest: file does not exist",
    });
    await vi.waitFor(async () =>
      expect((await status()).downloads).toMatchObject([
        {
          id: "llama3.2:3b",
          problem: "pull model manifest: file does not exist",
        },
      ]),
    );
  });

  it("waits for Download anyway on a processor that's likely too slow", async () => {
    const { ollama, act } = await home({ host: piHost });

    expect(await refusal(act("ollama.download", { model: "qwen3:1.7b" }))).toBe(
      "conflict",
    );
    await act("ollama.download", { model: "qwen3:1.7b", anyway: true });

    await vi.waitFor(() => expect(ollama.pulls).toHaveLength(1));
  });

  it("refuses a model it doesn't offer, or one that doesn't fit", async () => {
    const { act } = await home({ host: piHost });

    expect(
      await refusal(
        act("ollama.download", { model: "mistral:7b", anyway: true }),
      ),
    ).toBe("not_found");
    expect(
      await refusal(
        act("ollama.download", { model: "qwen3:8b", anyway: true }),
      ),
    ).toBe("conflict");
  });

  it("holds room for downloads that start together", async () => {
    const { ollama, act, status } = await home({
      host: () => ({ ...piHost(), storage: { freeBytes: 5 * gb } }),
    });
    const requests = await Promise.all([
      refusal(act("ollama.download", { model: "qwen3:1.7b", anyway: true })),
      refusal(act("ollama.download", { model: "llama3.2:3b", anyway: true })),
    ]);
    expect(requests).toContain(null);
    expect(requests).toContain("conflict");
    expect(ollama.pulls).toHaveLength(1);
    expect((await status()).offered).toEqual([]);

    await act("ollama.stop", { model: ollama.pulls[0]!.model });
    expect((await status()).offered).toHaveLength(3);
  });

  it("keeps a download running when asked to remove a model that isn't installed", async () => {
    const { ollama, act, status } = await home();
    await act("ollama.download", { model: "qwen3:4b" });
    expect(await refusal(act("ollama.remove", { model: "qwen3:4b" }))).toBe(
      "not_found",
    );
    expect(ollama.pulls[0]!.aborted).toBe(false);
    expect((await status()).downloads).toHaveLength(1);
  });

  it("removes a model by the name Ollama lists, including its namespace", async () => {
    const { ollama, act } = await home();
    const model = "library/CustomModel:latest";
    ollama.models = [{ name: model, size: 2.5 * gb }];

    await act("ollama.remove", { model });

    expect(ollama.deleted).toEqual([model]);
    expect(await refusal(act("ollama.remove", { model }))).toBe("not_found");
  });

  it("says when Ollama doesn't answer yet", async () => {
    const { ollama, status } = await home();
    ollama.isUp = false;

    const shown = await status();

    expect(shown.isAnswering).toBe(false);
    expect(shown.models).toEqual([]);
  });

  it("stops its downloads as it stops", async () => {
    const { app, ollama, act } = await home();
    await act("ollama.download", { model: "qwen3:4b" });
    await vi.waitFor(() => expect(ollama.pulls).toHaveLength(1));

    await app.stop!(undefined as never, { reason: "off" });

    expect(ollama.pulls[0]!.aborted).toBe(true);
  });
});
