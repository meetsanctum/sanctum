import { defineAction, defineApp, maxAppSecrets } from "@meetsanctum/app-sdk";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { openCoreDatabase, type OpenCoreDatabase } from "../src/database.js";
import { appSecrets } from "../src/app-host/schema.js";
import { createAppSecrets, secretsKeyFile } from "../src/app-host/secrets.js";
import { claimed, post, testCore, type TestCore } from "./support.js";

// An app's own secrets, such as a device's key: sealed in the core's
// database under a key beside it, read by that app alone, and said in no log.

const value = "dGhpcyBpcyBhIGRldmljZSBrZXkgb2YgdGhlIGhvbWU=";

function keeper(id: string) {
  const keep = defineAction({
    id: "keeper.keep",
    title: "Keep a secret",
    tier: "write",
    input: z.object({ name: z.string(), value: z.string() }),
    output: z.object({}),
    async run(ctx, input) {
      await ctx.secrets.set(input.name, input.value);
      return {};
    },
  });
  const read = defineAction({
    id: "keeper.read",
    title: "Read a secret",
    tier: "read",
    input: z.object({ name: z.string() }),
    output: z.object({ value: z.string().nullable() }),
    async run(ctx, input) {
      return { value: await ctx.secrets.get(input.name) };
    },
  });
  const forget = defineAction({
    id: "keeper.forget",
    title: "Forget a secret",
    tier: "write",
    input: z.object({ name: z.string() }),
    output: z.object({}),
    async run(ctx, input) {
      await ctx.secrets.delete(input.name);
      return {};
    },
  });
  return defineApp({
    id,
    name: "Keeper",
    version: "0.1.0",
    core: "^1.0.0",
    permissions: [],
    actions: [keep, read, forget],
    events: [],
  });
}

describe("an app's secrets", () => {
  async function keepers() {
    const core = await testCore({
      apps: [
        { app: keeper("test.keeper"), origin: "official" },
        { app: keeper("test.other"), origin: "official" },
      ],
    });
    return { core, maya: await claimed(core) };
  }

  const call = (
    core: TestCore,
    who: Awaited<ReturnType<typeof claimed>>,
    app: string,
    action: string,
    input: object,
  ) => post(core, `/api/apps/${app}/actions/keeper.${action}`, input, who);

  it("are the app's alone, sealed in the core's database and said in no log", async () => {
    const { core, maya } = await keepers();

    const kept = await call(core, maya, "test.keeper", "keep", {
      name: "device:aa:bb",
      value,
    });
    expect(kept.statusCode).toBe(200);

    const read = await call(core, maya, "test.keeper", "read", {
      name: "device:aa:bb",
    });
    expect(read.json()).toEqual({ value });
    const another = await call(core, maya, "test.other", "read", {
      name: "device:aa:bb",
    });
    expect(another.json()).toEqual({ value: null });

    const row = core.db.select().from(appSecrets).get()!;
    expect(row).toMatchObject({ appId: "test.keeper", name: "device:aa:bb" });
    expect(row.sealed).not.toContain(value);
    expect(Buffer.from(row.sealed, "base64").toString("latin1")).not.toContain(
      Buffer.from(value, "base64").toString("latin1"),
    );
    expect(core.logs.join("\n")).not.toContain(value);
  });

  it("are replaced and forgotten by their name", async () => {
    const { core, maya } = await keepers();
    const name = "pending:aa:bb";

    await call(core, maya, "test.keeper", "keep", { name, value: "first" });
    await call(core, maya, "test.keeper", "keep", { name, value: "second" });
    expect(
      (await call(core, maya, "test.keeper", "read", { name })).json(),
    ).toEqual({ value: "second" });

    await call(core, maya, "test.keeper", "forget", { name });
    expect(
      (await call(core, maya, "test.keeper", "read", { name })).json(),
    ).toEqual({ value: null });
  });

  it.each([
    ["a name the core can't keep", { name: "a key/with a slash", value }],
    ["a value over 4 KB", { name: "big", value: "x".repeat(4_097) }],
  ])(
    "fail an app that keeps one by %s, naming neither",
    async (_what, input) => {
      const { core, maya } = await keepers();

      const kept = await call(core, maya, "test.keeper", "keep", input);

      expect(kept.statusCode).toBe(500);
      expect(kept.body).not.toContain(input.value.slice(0, 64));
      expect(core.logs.join("\n")).not.toContain(input.value.slice(0, 64));
      expect(core.db.select().from(appSecrets).all()).toEqual([]);
    },
  );
});

describe("the core's sealed secrets", () => {
  let dataDir: string;
  const opened: OpenCoreDatabase[] = [];
  const open = () => {
    const database = openCoreDatabase(dataDir);
    opened.push(database);
    return database;
  };

  afterEach(async () => {
    for (const database of opened.splice(0)) database.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function fresh() {
    dataDir = await mkdtemp(join(tmpdir(), "sanctum-secrets-"));
    const logs: string[] = [];
    const secrets = createAppSecrets(open().db, {
      dataDir,
      log: (line) => logs.push(line),
    });
    return { secrets, logs };
  }

  it("are sealed under a key only the core's user reads, which outlasts a restart", async () => {
    const { secrets } = await fresh();
    secrets.put("test.keeper", "device", value);

    const key = join(dataDir, secretsKeyFile);
    expect((await readFile(key)).length).toBe(32);
    expect((await stat(key)).mode & 0o777).toBe(0o600);

    const again = createAppSecrets(open().db, { dataDir, log() {} });
    expect(again.get("test.keeper", "device")).toBe(value);
  });

  it("open only in the row they were sealed for", async () => {
    const { secrets, logs } = await fresh();
    const { db } = opened[0]!;
    secrets.put("test.keeper", "device", value);
    const row = db.select().from(appSecrets).get()!;
    db.insert(appSecrets)
      .values({ ...row, appId: "test.other" })
      .run();

    expect(secrets.get("test.other", "device")).toBeNull();
    expect(logs).toEqual([
      "apps: test.other's secret device doesn't open with this core's key",
    ]);
  });

  it("are as good as none once the key they were sealed with is gone", async () => {
    const { secrets } = await fresh();
    secrets.put("test.keeper", "device", value);
    await rm(join(dataDir, secretsKeyFile));

    const logs: string[] = [];
    const again = createAppSecrets(open().db, {
      dataDir,
      log: (line) => logs.push(line),
    });

    expect(again.get("test.keeper", "device")).toBeNull();
    expect(logs.join("\n")).not.toContain(value);
  });

  it(`keep at most ${maxAppSecrets} for an app, replacing one among them`, async () => {
    const { secrets } = await fresh();
    for (let each = 0; each < maxAppSecrets; each += 1) {
      secrets.put("test.keeper", `device:${each}`, value);
    }

    expect(() => secrets.put("test.keeper", "one-more", value)).toThrow(
      /64 secrets already/,
    );
    secrets.put("test.keeper", "device:0", "replaced");
    secrets.put("test.other", "device:0", value);
    expect(secrets.get("test.keeper", "device:0")).toBe("replaced");
  });
});
