import { defineAction, defineApp } from "@meetsanctum/app-sdk";
import { sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { createActivity } from "../src/activity/activity.js";
import type { AppPackage } from "./runner-apps.js";
import { loadAppPackage } from "./runner-apps.js";
import { shippedApps } from "../src/app-host/loader.js";
import { notes } from "./fixtures/apps/notes/schema.js";
import {
  claimed,
  fixtureApps,
  post,
  testCore,
  type TestCore,
} from "./support.js";

// Loading app packages, each app's own database and running its actions.

const base = { name: "Test", version: "0.1.0", core: "^1.0.0", events: [] };

function activity(core: TestCore, appId: string) {
  return createActivity(core.db)
    .recent()
    .filter((entry) => entry.source === appId);
}

// Runs any SQL it is handed on its own database and reports what happened.
const spy: AppPackage = {
  origin: "system",
  app: defineApp({
    ...base,
    id: "test.spy",
    permissions: [],
    actions: [
      defineAction({
        id: "spy.run",
        title: "Run SQL",
        tier: "read",
        input: z.object({ sql: z.string() }),
        output: z.object({
          rows: z.array(z.unknown()).optional(),
          error: z.string().optional(),
        }),
        async run(ctx, input) {
          try {
            return { rows: await ctx.storage.db.all(sql.raw(input.sql)) };
          } catch (error) {
            // Drizzle wraps what the core answered.
            const { cause } = error as Error;
            return { error: (cause as Error).message };
          }
        },
      }),
    ],
  }),
};

async function runSql(statement: string, apps: AppPackage[] = [spy]) {
  const core = await testCore({ apps });
  const { token } = await claimed(core);
  const response = await post(
    core,
    "/api/apps/test.spy/actions/spy.run",
    { sql: statement },
    { token },
  );
  return {
    core,
    result: response.json() as { rows?: unknown[]; error?: string },
  };
}

describe("loading app packages", () => {
  it("refuses entry and migrations paths that escape through symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sanctum-app-paths-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const packageDir = join(dir, "app");
    await mkdir(packageDir);
    await writeFile(
      join(packageDir, "package.json"),
      '{"type":"module","main":"entry.js"}',
    );
    await writeFile(join(dir, "outside.js"), "export default 42;");
    await symlink(join(dir, "outside.js"), join(packageDir, "entry.js"));
    await expect(loadAppPackage(packageDir, "system")).rejects.toThrow(
      /leads out of the package/,
    );

    await rm(join(packageDir, "entry.js"));
    await writeFile(
      join(packageDir, "entry.js"),
      `export default ${JSON.stringify({ ...base, id: "test.paths", permissions: [], actions: [], migrations: "migrations" })};`,
    );
    await mkdir(join(dir, "outside-migrations"));
    await symlink(
      join(dir, "outside-migrations"),
      join(packageDir, "migrations"),
    );
    await expect(loadAppPackage(packageDir, "system")).rejects.toThrow(
      /leads out of the package/,
    );
  });
});

describe("the apps an image ships", () => {
  it("are known by the ids their manifests have", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sanctum-shipped-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    for (const [folder, id] of [
      ["weather", "sanctum.example"],
      ["notes", "sanctum.example-notes"],
    ] as const) {
      await mkdir(join(dir, folder));
      await writeFile(
        join(dir, folder, "sanctum-app.json"),
        JSON.stringify({ id }),
      );
    }

    expect(await shippedApps(dir, () => {})).toEqual([
      "sanctum.example",
      "sanctum.example-notes",
    ]);
  });

  it("leave out a folder with no manifest to read, and say so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sanctum-shipped-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, "broken"));
    const logs: string[] = [];

    expect(await shippedApps(dir, (line) => logs.push(line))).toEqual([]);
    expect(logs).toEqual([
      expect.stringMatching(/^apps: broken has no manifest to read/),
    ]);
  });

  it("are none where the image has no such folder, as a development stack's", async () => {
    expect(await shippedApps("/nonexistent", () => {})).toEqual([]);
  });
});

describe("an app's database", () => {
  it("is its own file, created and migrated at start", async () => {
    const notesApp = await loadAppPackage(join(fixtureApps, "notes"), "system");
    const core = await testCore({ apps: [notesApp, spy] });

    expect(existsSync(join(core.dataDir, "apps", "test.notes.db"))).toBe(true);
    expect(existsSync(join(core.dataDir, "apps", "test.spy.db"))).toBe(true);
    expect(
      core.apps.list().map(({ id, name, version, origin }) => ({
        id,
        name,
        version,
        origin,
      })),
    ).toEqual([
      { id: "test.notes", name: "Notes", version: "0.1.0", origin: "system" },
      { id: "test.spy", name: "Test", version: "0.1.0", origin: "system" },
    ]);
  });

  it("holds none of another app's tables or the core's", async () => {
    const notesApp = await loadAppPackage(join(fixtureApps, "notes"), "system");

    for (const [statement, error] of [
      ["select * from notes", "no such table: notes"],
      ["select * from people", "no such table: people"],
      ["select * from auth_tokens", "no such table: auth_tokens"],
    ] as const) {
      const { result } = await runSql(statement, [notesApp, spy]);
      expect(result).toEqual({ error });
    }
    expect((await runSql("select name from sqlite_master")).result).toEqual({
      rows: [],
    });
  });

  it("refuses statements that reach beyond its own rows", async () => {
    const core = await testCore();
    const coreDb = join(core.dataDir, "core.db");

    for (const [statement, keyword] of [
      [`attach database '${coreDb}' as core`, "ATTACH"],
      [`/* hidden */ attach database '${coreDb}' as core`, "ATTACH"],
      ["vacuum into '/tmp/copy.db'", "VACUUM"],
      ["pragma writable_schema = on", "PRAGMA"],
      ["create table mine (id integer)", "CREATE"],
      ["drop table if exists notes", "DROP"],
    ] as const) {
      const { result } = await runSql(statement);
      expect(result.error).toBe(
        `test.spy may not run ${keyword} statements on its database`,
      );
    }
    expect(
      (await runSql(`select 1; attach database '${coreDb}' as core`)).result,
    ).toEqual({
      error: "The supplied SQL string contains more than one statement",
    });
  });
});

describe("transactions", () => {
  // An app on the notes fixture's schema whose transaction waits for the
  // test before it fails and rolls back.
  function txApp() {
    let entered!: () => void;
    let resume!: () => void;
    const steps = {
      entered: new Promise<void>((resolve) => (entered = resolve)),
      resume: new Promise<void>((resolve) => (resume = resolve)),
      release: () => resume(),
    };
    const pkg: AppPackage = {
      origin: "system",
      migrationsFolder: join(fixtureApps, "notes", "migrations"),
      app: defineApp({
        ...base,
        id: "test.tx",
        permissions: [],
        actions: [
          defineAction({
            id: "tx.undo",
            title: "Write, then undo",
            tier: "write",
            input: z.object({ wait: z.boolean() }),
            output: z.null(),
            async run(ctx, input) {
              await ctx.storage.db.transaction(async (tx) => {
                await tx.insert(notes).values({ text: "undone" });
                entered();
                if (input.wait) {
                  await steps.resume;
                  throw new Error("undo");
                }
                // Never ends: the call times out.
                await new Promise(() => {});
              });
              return null;
            },
          }),
          defineAction({
            id: "tx.add",
            title: "Add",
            tier: "write",
            input: z.object({}),
            output: z.null(),
            async run(ctx) {
              await ctx.storage.db.insert(notes).values({ text: "kept" });
              return null;
            },
          }),
          defineAction({
            id: "tx.list",
            title: "List",
            tier: "read",
            input: z.object({}),
            output: z.array(z.string()),
            async run(ctx) {
              const rows = await ctx.storage.db.select().from(notes).all();
              return rows.map((row) => row.text);
            },
          }),
        ],
      }),
    };
    return { pkg, steps };
  }

  it("keeps another call's statements out of a transaction until it ends", async () => {
    const { pkg, steps } = txApp();
    const core = await testCore({ apps: [pkg] });
    const { token } = await claimed(core);
    const url = (action: string) => `/api/apps/test.tx/actions/${action}`;

    const undo = post(core, url("tx.undo"), { wait: true }, { token });
    await steps.entered;
    let added = false;
    const add = post(core, url("tx.add"), {}, { token }).then((response) => {
      added = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(added).toBe(false);
    steps.release();

    expect((await undo).json()).toEqual({ error: "app_failed" });
    expect((await add).statusCode).toBe(200);
    expect((await post(core, url("tx.list"), {}, { token })).json()).toEqual([
      "kept",
    ]);
  });

  it("rolls back a transaction whose call timed out", async () => {
    const { pkg } = txApp();
    const core = await testCore({ apps: [pkg], appTimeoutMs: 50 });
    const { token } = await claimed(core);
    const url = (action: string) => `/api/apps/test.tx/actions/${action}`;

    const timedOut = await post(
      core,
      url("tx.undo"),
      { wait: false },
      { token },
    );
    const add = await post(core, url("tx.add"), {}, { token });

    expect(timedOut.statusCode).toBe(504);
    expect(timedOut.json()).toEqual({ error: "timeout" });
    expect(add.statusCode).toBe(200);
    expect((await post(core, url("tx.list"), {}, { token })).json()).toEqual([
      "kept",
    ]);
    expect(core.logs).toContain("apps: tx.undo timed out");
    // It may have changed something before it stopped, so it is logged.
    expect(activity(core, "test.tx")).toContainEqual(
      expect.objectContaining({
        action: "tx.undo",
        outcome: "failed",
        reason: "timeout",
      }),
    );
  });
});

describe("a failing app", () => {
  it.each(["input", "output"])(
    "contains errors thrown by an %s schema",
    async (stage) => {
      const brokenSchema = z.unknown().refine(() => {
        throw new Error("broken refinement");
      });
      const core = await testCore({
        apps: [
          {
            origin: "system",
            app: defineApp({
              ...base,
              id: "test.schema",
              permissions: [],
              actions: [
                defineAction({
                  id: "schema.run",
                  title: "Run",
                  tier: "read",
                  input: stage === "input" ? brokenSchema : z.object({}),
                  output: stage === "output" ? brokenSchema : z.unknown(),
                  async run() {
                    return null;
                  },
                }),
              ],
            }),
          },
        ],
      });
      const { token } = await claimed(core);
      const response = await post(
        core,
        "/api/apps/test.schema/actions/schema.run",
        {},
        { token },
      );
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "app_failed" });
      // The app's side reads its own schemas, and says which failed.
      expect(core.logs).toContain(
        stage === "input"
          ? "apps: schema.run failed (schema.run's schema failed: Error: broken refinement)"
          : "apps: schema.run failed (schema.run returned something its output schema refuses)",
      );
    },
  );

  const failing: AppPackage = {
    origin: "system",
    app: defineApp({
      ...base,
      id: "test.failing",
      permissions: [],
      actions: [
        defineAction({
          id: "failing.throw",
          title: "Throw",
          tier: "read",
          input: z.object({}),
          output: z.null(),
          async run() {
            throw new Error("broken");
          },
        }),
        defineAction({
          id: "failing.lie",
          title: "Return the wrong thing",
          tier: "read",
          input: z.object({}),
          output: z.object({ count: z.number() }),
          async run() {
            return { count: "many" } as unknown as { count: number };
          },
        }),
        defineAction({
          id: "failing.write",
          title: "Write, then throw",
          tier: "write",
          input: z.object({}),
          output: z.null(),
          async run() {
            throw new Error("half done");
          },
        }),
        defineAction({
          id: "failing.text",
          title: "Return a bare string",
          tier: "read",
          input: z.object({}),
          output: z.string(),
          async run() {
            return "plain";
          },
        }),
      ],
    }),
  };

  it("answers 500 for an error or an output its schema refuses, and logs it", async () => {
    const core = await testCore({ apps: [failing] });
    const { token } = await claimed(core);

    for (const action of ["failing.throw", "failing.lie"]) {
      const response = await post(
        core,
        `/api/apps/test.failing/actions/${action}`,
        {},
        { token },
      );
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "app_failed" });
    }
    expect(core.logs).toEqual([
      "apps: failing.throw failed (broken)",
      "apps: failing.lie failed (failing.lie returned something its output schema refuses)",
    ]);
    // Failed reads changed nothing, so the activity log has no entry.
    expect(activity(core, "test.failing")).toEqual([]);
  });

  it("takes a refusal from an app's own copy of the SDK as a refusal", async () => {
    // An app package may bring its own copy of the SDK, whose ActionError
    // is not the core's class.
    class ActionError extends Error {
      constructor(readonly code: string) {
        super(code);
        this.name = "ActionError";
      }
    }
    const core = await testCore({
      apps: [
        {
          origin: "official",
          app: defineApp({
            ...base,
            id: "test.copy",
            permissions: [],
            actions: [
              defineAction({
                id: "copy.refuse",
                title: "Refuse",
                tier: "write",
                input: z.object({}),
                output: z.null(),
                async run() {
                  throw new ActionError("conflict");
                },
              }),
            ],
          }),
        },
      ],
    });
    const { token } = await claimed(core);

    const response = await post(
      core,
      "/api/apps/test.copy/actions/copy.refuse",
      {},
      { token },
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "conflict" });
    expect(activity(core, "test.copy")).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "conflict" }),
    ]);
  });

  it("logs a failed call that may have changed something", async () => {
    const core = await testCore({ apps: [failing] });
    const maya = await claimed(core);

    const response = await post(
      core,
      "/api/apps/test.failing/actions/failing.write",
      {},
      { token: maya.token },
    );

    expect(response.json()).toEqual({ error: "app_failed" });
    expect(activity(core, "test.failing")).toEqual([
      expect.objectContaining({
        action: "failing.write",
        outcome: "failed",
        reason: "app_failed",
        personId: maya.client.personId,
        clientId: maya.client.id,
      }),
    ]);
  });

  it("answers any output as JSON", async () => {
    const core = await testCore({ apps: [failing] });
    const { token } = await claimed(core);

    const response = await post(
      core,
      "/api/apps/test.failing/actions/failing.text",
      undefined,
      { token },
    );

    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.json()).toBe("plain");
  });

  it("preserves a JSON null input for the action's schema", async () => {
    const core = await testCore({
      apps: [
        {
          origin: "system",
          app: defineApp({
            ...base,
            id: "test.null",
            permissions: [],
            actions: [
              defineAction({
                id: "null.echo",
                title: "Echo null",
                tier: "read",
                input: z.null(),
                output: z.null(),
                async run(_ctx, input) {
                  return input;
                },
              }),
            ],
          }),
        },
      ],
    });
    const { token } = await claimed(core);
    const response = await post(
      core,
      "/api/apps/test.null/actions/null.echo",
      "null",
      {
        token,
        headers: { "content-type": "application/json" },
      },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });
});
