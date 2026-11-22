import type { ModelSourceLook, ModelsInfo } from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { activity } from "../src/activity/schema.js";
import { modelSources } from "../src/models/schema.js";
import { fakeSources, officeMac, type FakeSources } from "./models-support.js";
import { claimed, get, post, testCore, type TestCore } from "./support.js";

// The home's AI models: the household adds Ollama on a computer in the home
// or a provider with its key, one source is in use, and Settings checks each
// with a short question and one tool. Keys are sealed and never answered.

async function home(sources: FakeSources = fakeSources()) {
  const core = await testCore({ modelFetchers: sources.fetchers });
  const { token } = await claimed(core);
  return { core, token, sources };
}

const send = (
  core: TestCore,
  method: "PATCH" | "DELETE",
  url: string,
  token: string,
  payload?: unknown,
) =>
  core.server.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

// The sources once no check is under way.
async function checked(core: TestCore) {
  await vi.waitFor(() => {
    expect(core.models.info().sources.some((each) => each.checking)).toBe(
      false,
    );
  });
  return core.models.info();
}

const addOfficeMac = (core: TestCore, token: string, model = "qwen3:8b") =>
  post(
    core,
    "/api/models/sources",
    { kind: "computer", address: officeMac, computer: "Office Mac", model },
    { token },
  );

describe("AI models", () => {
  it("finds Ollama on a computer in the home and lists its models", async () => {
    const { core, token } = await home();
    const look = await post(
      core,
      "/api/models/look",
      { kind: "computer", address: officeMac },
      { token },
    );
    expect(look.statusCode).toBe(200);
    expect(look.json<ModelSourceLook>()).toEqual({
      found: true,
      address: "192.168.1.40:11434",
      models: [
        { id: "llama3.2:3b", name: "Llama3.2 3B", size: 2_000_000_000 },
        { id: "qwen3:8b", name: "Qwen3 8B", size: 5_200_000_000 },
      ],
    });
  });

  it("refuses an address outside the home's network", async () => {
    const { core, token, sources } = await home();
    for (const address of ["8.8.8.8", "127.0.0.1", "localhost:11434"]) {
      const look = await post(
        core,
        "/api/models/look",
        { kind: "computer", address },
        { token },
      );
      expect(look.json<ModelSourceLook>()).toMatchObject({ found: false });
    }
    const refused = await post(
      core,
      "/api/models/look",
      { kind: "computer", address: "8.8.8.8" },
      { token },
    );
    expect(refused.json()).toEqual({ found: false, problem: "refused" });
    expect(sources.requests).toEqual([]);
  });

  it("says when nothing answers at an address", async () => {
    const { core, token, sources } = await home();
    sources.ollama.up = false;
    const look = await post(
      core,
      "/api/models/look",
      { kind: "computer", address: `${officeMac}:11434` },
      { token },
    );
    expect(look.json()).toEqual({
      found: false,
      problem: "unreachable",
      address: "192.168.1.40:11434",
    });
  });

  it("adds the first source in use and checks it with a tool", async () => {
    const { core, token, sources } = await home();
    const added = await addOfficeMac(core, token);
    expect(added.statusCode).toBe(200);
    expect(added.json<ModelsInfo>().sources).toMatchObject([
      {
        kind: "computer",
        model: "qwen3:8b",
        modelName: "Qwen3 8B",
        inUse: true,
      },
    ]);
    const [source] = (await checked(core)).sources;
    expect(source).toMatchObject({
      computer: "Office Mac",
      address: "192.168.1.40:11434",
      check: { outcome: "answered" },
      tokens: { today: 46, month: 46 },
    });
    expect(source!.check!.firstWordMs).toBeGreaterThanOrEqual(0);
    // The check asked as an app's turn would: one tool, streamed.
    expect(sources.chats[0]).toMatchObject({
      model: "qwen3:8b",
      stream: true,
      max_tokens: 256,
      tools: [{ type: "function", function: { name: "get_time" } }],
    });
    const entry = core.db
      .select()
      .from(activity)
      .where(eq(activity.action, "models.add"))
      .get();
    expect(entry).toMatchObject({
      outcome: "ok",
      subjectId: source!.id,
      detail: { kind: "computer", model: "Qwen3 8B", computer: "Office Mac" },
    });
  });

  it("says when a model answers without using the tool", async () => {
    const sources = fakeSources();
    sources.ollama.answer = { callsTool: false };
    const { core, token } = await home(sources);
    await addOfficeMac(core, token, "llama3.2:3b");
    const [source] = (await checked(core)).sources;
    expect(source!.check).toMatchObject({ outcome: "noTool" });
  });

  it("refuses a model the computer doesn't have", async () => {
    const { core, token } = await home();
    const added = await addOfficeMac(core, token, "mistral:7b");
    expect(added.statusCode).toBe(404);
    expect(core.models.info().sources).toEqual([]);
  });

  it("keeps a provider's key sealed and never answers it", async () => {
    const { core, token, sources } = await home();
    const wrong = await post(
      core,
      "/api/models/look",
      { kind: "openrouter", key: "sk-or-v1-wrong-key" },
      { token },
    );
    expect(wrong.json()).toEqual({ found: false, problem: "key" });

    const look = await post(
      core,
      "/api/models/look",
      { kind: "openrouter", key: sources.openRouter.key },
      { token },
    );
    expect(look.json<ModelSourceLook>()).toMatchObject({
      found: true,
      models: [
        { id: "anthropic/claude-haiku-4.5" },
        { id: "openai/gpt-5-mini", name: "OpenAI: GPT-5 Mini" },
      ],
    });
    const added = await post(
      core,
      "/api/models/sources",
      {
        kind: "openrouter",
        key: sources.openRouter.key,
        model: "openai/gpt-5-mini",
      },
      { token },
    );
    expect(added.statusCode).toBe(200);
    expect(added.body).not.toContain(sources.openRouter.key);
    const [source] = (await checked(core)).sources;
    expect(source).toMatchObject({
      kind: "openrouter",
      modelName: "OpenAI: GPT-5 Mini",
      keyEnd: "4f2a",
      check: { outcome: "answered" },
    });
    const listed = await get(core, "/api/models", { token });
    expect(listed.body).not.toContain(sources.openRouter.key);
    const row = core.db.select().from(modelSources).get();
    expect(row!.sealedKey).not.toContain(sources.openRouter.key);
    // The key went only to OpenRouter.
    expect(
      sources.requests
        .filter((each) => each.authorization?.includes(sources.openRouter.key))
        .every((each) => each.url.startsWith("https://openrouter.ai/")),
    ).toBe(true);
  });

  it("uses one source at a time and none once it's removed", async () => {
    const { core, token, sources } = await home();
    await addOfficeMac(core, token);
    await post(
      core,
      "/api/models/sources",
      {
        kind: "openrouter",
        key: sources.openRouter.key,
        model: "openai/gpt-5-mini",
      },
      { token },
    );
    let [mac, router] = (await checked(core)).sources;
    expect([mac!.inUse, router!.inUse]).toEqual([true, false]);

    await post(core, `/api/models/sources/${router!.id}/use`, {}, { token });
    [mac, router] = (await checked(core)).sources;
    expect([mac!.inUse, router!.inUse]).toEqual([false, true]);

    const removed = await send(
      core,
      "DELETE",
      `/api/models/sources/${router!.id}`,
      token,
    );
    expect(removed.json<ModelsInfo>().sources).toMatchObject([
      { id: mac!.id, inUse: false },
    ]);
  });

  it("renames a computer and changes its model", async () => {
    const { core, token } = await home();
    await addOfficeMac(core, token);
    const [source] = (await checked(core)).sources;
    const changed = await send(
      core,
      "PATCH",
      `/api/models/sources/${source!.id}`,
      token,
      { computer: "Studio Mac", model: "llama3.2:3b" },
    );
    expect(changed.json<ModelsInfo>().sources).toMatchObject([
      {
        computer: "Studio Mac",
        model: "llama3.2:3b",
        modelName: "Llama3.2 3B",
      },
    ]);
  });

  it("says since when the source in use hasn't answered", async () => {
    const { core, token, sources } = await home();
    await addOfficeMac(core, token);
    await checked(core);
    sources.ollama.up = false;
    await post(
      core,
      `/api/models/sources/${core.models.info().sources[0]!.id}/check`,
      {},
      { token },
    );
    let [source] = (await checked(core)).sources;
    expect(source).toMatchObject({
      check: { outcome: "failed", problem: "unreachable" },
      downSince: "2026-10-26T12:00:00.000Z",
    });
    sources.ollama.up = true;
    await post(core, `/api/models/sources/${source!.id}/check`, {}, { token });
    [source] = (await checked(core)).sources;
    expect(source!.downSince).toBeUndefined();
  });

  it("keeps the sources across a restart", async () => {
    const { core, token, sources } = await home();
    await addOfficeMac(core, token);
    await checked(core);
    await core.stop();
    const again = await testCore({
      dataDir: core.dataDir,
      modelFetchers: sources.fetchers,
    });
    expect(again.models.info().sources).toMatchObject([
      { modelName: "Qwen3 8B", inUse: true, check: { outcome: "answered" } },
    ]);
  });
});
