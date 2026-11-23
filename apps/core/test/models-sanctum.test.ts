import type { ModelSourceLook, ModelsInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { fakeManager } from "./manager-support.js";
import {
  fakeSources,
  sanctumOllama,
  type FakeSources,
} from "./models-support.js";
import { claimed, post, testCore, type TestCore } from "./support.js";

// Ollama on Sanctum as a source of the home's AI model: reached at the
// address the manager gives while its Ollama runs, never one typed in, kept
// loaded once in use, and counted by day with the other sources.

async function home(
  options: { url?: string | null; sources?: FakeSources } = {},
) {
  const sources = options.sources ?? fakeSources();
  const url = options.url === undefined ? sanctumOllama : options.url;
  const core = await testCore({
    modelFetchers: sources.fetchers,
    manager: { ...fakeManager().manager, serviceUrl: async () => url },
  });
  const { token } = await claimed(core);
  return { core, token, sources };
}

async function checked(core: TestCore) {
  await vi.waitFor(() => {
    expect(core.models.info().sources.some((each) => each.checking)).toBe(
      false,
    );
  });
  return core.models.info();
}

const addSanctum = (core: TestCore, token: string) =>
  post(
    core,
    "/api/models/sources",
    { kind: "sanctum", model: "qwen3:8b" },
    { token },
  );

describe("Ollama on Sanctum as a source", () => {
  it("lists the models Ollama on Sanctum has", async () => {
    const { core, token } = await home();

    const look = await post(
      core,
      "/api/models/look",
      { kind: "sanctum" },
      {
        token,
      },
    );

    expect(look.json<ModelSourceLook>()).toEqual({
      found: true,
      models: [
        { id: "llama3.2:3b", name: "Llama3.2 3B", size: 2_000_000_000 },
        { id: "qwen3:8b", name: "Qwen3 8B", size: 5_200_000_000 },
      ],
    });
  });

  it("isn't there while the manager runs no Ollama", async () => {
    const { core, token } = await home({ url: null });

    const look = await post(
      core,
      "/api/models/look",
      { kind: "sanctum" },
      {
        token,
      },
    );
    const added = await addSanctum(core, token);

    expect(look.json()).toEqual({ found: false, problem: "unreachable" });
    expect(added.statusCode).toBe(503);
  });

  it("is added, checked and shown to apps as Sanctum, in the home", async () => {
    const { core, token } = await home();

    expect((await addSanctum(core, token)).statusCode).toBe(200);
    const [source] = (await checked(core)).sources;

    expect(source).toMatchObject({
      kind: "sanctum",
      model: "qwen3:8b",
      modelName: "Qwen3 8B",
      inUse: true,
      check: { outcome: "answered" },
    });
    expect(source).not.toHaveProperty("address");
    expect(source).not.toHaveProperty("keyEnd");
    expect(core.models.inUse()?.shown).toEqual({
      name: "Sanctum",
      model: "Qwen3 8B",
      inHome: true,
    });
  });

  it("refuses a key or a computer's name for it", async () => {
    const { core, token } = await home();
    await addSanctum(core, token);
    const { id } = (await checked(core)).sources[0]!;

    for (const payload of [{ key: "sk-0123456789" }, { computer: "Mac" }]) {
      const changed = await core.server.inject({
        method: "PATCH",
        url: `/api/models/sources/${id}`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      expect(changed.statusCode).toBe(400);
    }
  });

  it("has Ollama load the model in use as the core starts", async () => {
    const { core, token, sources } = await home();
    await addSanctum(core, token);
    await checked(core);
    sources.chats.length = 0;

    core.models.start();

    await vi.waitFor(() =>
      expect(sources.chats).toContainEqual({
        model: "qwen3:8b",
        keep_alive: -1,
      }),
    );
    await core.models.stop();
  });

  it("counts the tokens of each day of the last 30, by source, app and check", async () => {
    const { core, token } = await home();
    await addSanctum(core, token);
    const { usage, sources } = (await checked(core)) as ModelsInfo;

    // Thirty days in a row, as the core's clock has them, today last.
    expect(usage.days).toHaveLength(30);
    const apart = (a: string, b: string) =>
      (Date.parse(b) - Date.parse(a)) / 86_400_000;
    expect(
      usage.days.slice(1).map((day, at) => apart(usage.days[at]!, day)),
    ).toEqual(Array(29).fill(1));
    expect(usage.sources).toEqual([
      { id: sources[0]!.id, tokens: expect.any(Array) },
    ]);
    expect(usage.sources[0]!.tokens.at(-1)).toBeGreaterThan(0);
    expect(usage.checks.at(-1)).toBe(usage.sources[0]!.tokens.at(-1));
    expect(usage.apps).toEqual([]);
  });
});
