import type { ModelSourceLook } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { fakeManager, managerSocket } from "./manager-support.js";
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
  options: {
    url?: string | null;
    sources?: FakeSources;
    serviceUrl?: () => Promise<string | null>;
  } = {},
) {
  const sources = options.sources ?? fakeSources();
  const manager = fakeManager().manager;
  const core = await testCore({
    modelFetchers: sources.fetchers,
    manager: {
      ...manager,
      serviceUrl:
        options.serviceUrl ??
        (async () => (options.url === undefined ? sanctumOllama : options.url)),
    },
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

  it("keeps the address a newer lookup found when an older one fails after it", async () => {
    const answers: ((url: string | null) => void)[] = [];
    let isWaiting = false;
    const { core, token } = await home({
      serviceUrl: () =>
        isWaiting
          ? new Promise<string | null>((resolve, reject) => {
              answers.push((url) =>
                url ? resolve(url) : reject(new Error("timed out")),
              );
            })
          : Promise.resolve(sanctumOllama),
    });
    await addSanctum(core, token);
    await checked(core);

    isWaiting = true;
    const older = post(
      core,
      "/api/models/look",
      { kind: "sanctum" },
      { token },
    );
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    const newer = post(
      core,
      "/api/models/look",
      { kind: "sanctum" },
      { token },
    );
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!(sanctumOllama);
    expect((await newer).json<ModelSourceLook>().found).toBe(true);
    answers[0]!(null);
    expect((await older).json<ModelSourceLook>().found).toBe(true);

    expect(core.models.inUse()?.endpoint()).toMatchObject({
      baseUrl: `${sanctumOllama}/v1`,
    });
  });

  it("answers with the address a lookup found while a newer one is still waiting", async () => {
    const answers: ((url: string | null) => void)[] = [];
    const { core, token } = await home({
      serviceUrl: () =>
        new Promise<string | null>((resolve) => answers.push(resolve)),
    });

    const older = post(
      core,
      "/api/models/look",
      { kind: "sanctum" },
      { token },
    );
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    const newer = post(
      core,
      "/api/models/look",
      { kind: "sanctum" },
      { token },
    );
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[0]!(sanctumOllama);

    expect((await older).json<ModelSourceLook>().found).toBe(true);
    answers[1]!(null);
    expect((await newer).json()).toEqual({
      found: false,
      problem: "unreachable",
    });
  });

  it("reads Ollama's running URL from the manager's service status", async () => {
    let service: { state: string; url?: string } = {
      state: "running",
      url: sanctumOllama,
    };
    const { client, received } = await managerSocket(() => ({
      status: 200,
      body: {
        service: { name: "ollama", apps: ["sanctum.ollama"], ...service },
      },
    }));

    expect(await client.serviceUrl("ollama")).toBe(sanctumOllama);
    service = { state: "starting" };
    expect(await client.serviceUrl("ollama")).toBeNull();
    expect(received).toEqual(
      Array(2).fill({
        method: "GET",
        url: "/api/services/ollama",
        body: undefined,
      }),
    );
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

  it("refuses a supplied key or address when looking for or adding Ollama", async () => {
    const { core, token, sources } = await home();
    for (const fields of [
      { key: "sk-0123456789" },
      { address: sanctumOllama },
    ]) {
      const look = await post(
        core,
        "/api/models/look",
        { kind: "sanctum", ...fields },
        { token },
      );
      const add = await post(
        core,
        "/api/models/sources",
        { kind: "sanctum", model: "qwen3:8b", ...fields },
        { token },
      );

      expect(look.statusCode).toBe(400);
      expect(add.statusCode).toBe(400);
    }
    expect(sources.requests).toEqual([]);
  });

  it("warms the saved model once Ollama becomes available after a restart", async () => {
    const { core, token, sources } = await home();
    await addSanctum(core, token);
    await checked(core);
    await core.stop();
    sources.chats.length = 0;

    let url: string | null = null;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let restarted: TestCore | undefined;
    try {
      restarted = await testCore({
        dataDir: core.dataDir,
        modelFetchers: sources.fetchers,
        manager: { ...fakeManager().manager, serviceUrl: async () => url },
      });
      expect(restarted.models.info().sources[0]?.downSince).toBeDefined();
      expect(sources.chats).toEqual([]);
      url = sanctumOllama;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() =>
        expect(sources.chats).toEqual([{ model: "qwen3:8b", keep_alive: -1 }]),
      );
      expect(restarted.models.info().sources[0]?.downSince).toBeUndefined();
    } finally {
      await restarted?.stop();
      vi.useRealTimers();
    }
  });

  it("counts the tokens of each day of the last 30, by source, app and check", async () => {
    const { core, token } = await home();
    await addSanctum(core, token);
    const { sources } = await checked(core);
    const source = sources[0]!;
    core.models.count(source.id, "sanctum.example", { read: 30, written: 10 });
    const { usage, apps, sources: updated } = core.models.info();

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
    expect(usage.apps).toEqual([
      { id: "sanctum.example", tokens: [...Array(29).fill(0), 40] },
    ]);
    expect(apps).toEqual([]);
    expect(usage.sources[0]!.tokens.at(-1)).toBe(usage.checks.at(-1)! + 40);
    expect(updated[0]!.tokens.today).toBe(usage.sources[0]!.tokens.at(-1));
  });
});
