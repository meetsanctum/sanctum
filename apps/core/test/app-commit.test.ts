import {
  defineAction,
  defineApp,
  defineEntityType,
  type AppContext,
  type AppDefinition,
  type WorkflowProblem,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { durably } from "../src/database.js";
import { appVersions } from "../src/app-host/schema.js";
import { base, supervised, useCleanUps } from "./app-apart-support.js";
import { claimed, get, testCore, type TestCore } from "./support.js";
import { addWorkflow, steps, trigger } from "./workflows-support.js";

// An update's commit: after any change of version, what an app that runs apart
// doesn't claim again goes, in one transaction with the row that says it runs that
// version.

useCleanUps();

const noteType = defineEntityType({
  id: "test.note",
  title: "Note",
  state: z.object({ text: z.string() }),
});
const tick = defineAction({
  id: "commit.tick",
  title: "Tick",
  tier: "write",
  input: z.object({}),
  output: z.unknown(),
  run: async () => "tick",
});
const everyFive = { every: 300 };

type Owned = {
  entities?: string[];
  jobs?: string[];
  workflows?: string[];
  // What it does at the end of its start, after claiming.
  then?: (ctx: AppContext) => Promise<void>;
};

const kept = {
  name: "Kept",
  graph: steps(trigger("at", "time", { time: "12:01" }), {
    id: "tick",
    kind: "step",
    app: "test.owner",
    piece: tick.id,
    config: {},
  }),
};

const app = (owned: () => Owned): AppDefinition =>
  defineApp({
    ...base,
    id: "test.owner",
    permissions: [
      { id: "workflows.manage", reason: "For the test.", needed: true },
    ],
    actions: [tick],
    provides: { entities: [noteType], steps: [tick] },
    start: async (ctx: AppContext) => {
      const { entities = [], jobs = [], workflows = [], then } = owned();
      for (const key of entities) {
        await ctx.entities.publish({
          type: noteType.id,
          key,
          name: key,
          state: { text: key },
        });
      }
      for (const key of jobs) {
        await ctx.jobs.schedule({
          key,
          action: tick,
          input: {},
          when: everyFive,
        });
      }
      for (const key of workflows) await ctx.workflows.put(key, kept);
      await then?.(ctx);
    },
  });

// What the home holds of it now.
const holds = (core: TestCore) => ({
  entities: core.entities
    .list({ app: "test.owner" })
    .map(({ key }) => key)
    .sort(),
  jobs: core.workflows.jobs.list("test.owner").map(({ key }) => key),
  workflows: core.workflows.kept
    .list("test.owner")
    .map(({ appKey }) => appKey)
    .sort(),
});

const row = (core: TestCore) => core.db.select().from(appVersions).all()[0];

// It starts on one version, and then on another with the same data.
async function updated(before: Owned, after: () => Owned) {
  const first = await supervised(app(() => before));
  await first.running();
  const second = await supervised(app(after), {
    version: "2.0.0",
    dataDir: first.core.dataDir,
  });
  return { first, second };
}

describe("after a change of version", () => {
  it("keeps what it claims and removes the rest, entities, jobs and workflows", async () => {
    const { second } = await updated(
      {
        entities: ["kept", "gone"],
        jobs: ["kept", "gone"],
        workflows: ["kept", "gone"],
      },
      () => ({ entities: ["kept"], jobs: ["kept"], workflows: ["kept"] }),
    );

    await second.running();

    expect(holds(second.core)).toEqual({
      entities: ["kept"],
      jobs: ["kept"],
      workflows: ["kept"],
    });
  });

  it("leaves an automation using what it removed saying why it can't run", async () => {
    const first = await supervised(app(() => ({ entities: ["kept", "gone"] })));
    await first.running();
    const { token } = await claimed(first.core);
    const using = (key: string) =>
      addWorkflow(first.core, token, {
        graph: steps(
          trigger("t", "entity", { app: "test.owner", key, type: noteType.id }),
          {
            id: "tick",
            kind: "step",
            app: "test.owner",
            piece: tick.id,
            config: {},
          },
        ),
      });
    const keeps = await using("kept");
    const loses = await using("gone");

    const second = await supervised(
      app(() => ({ entities: ["kept"] })),
      { version: "2.0.0", dataDir: first.core.dataDir },
    );
    await second.running();

    const problems = async (id: string) =>
      (
        (await get(second.core, "/api/workflows", { token })).json() as {
          id: string;
          problems: WorkflowProblem[];
        }[]
      ).find((each) => each.id === id)!.problems;
    expect(await problems(keeps.id)).toEqual([]);
    expect(await problems(loses.id)).toEqual([
      {
        node: "t",
        field: "key",
        message: "The note it names was removed",
      },
    ]);
  });

  it("counts claiming again though nothing changed", async () => {
    const owned = { entities: ["same"], jobs: ["same"], workflows: ["same"] };
    const { second } = await updated(owned, () => owned);

    await second.running();

    expect(holds(second.core)).toEqual({
      entities: ["same"],
      jobs: ["same"],
      workflows: ["same"],
    });
  });

  it("doesn't count listing as claiming", async () => {
    const { second } = await updated(
      { entities: ["listed"], jobs: ["listed"], workflows: ["listed"] },
      () => ({
        then: async (ctx) => {
          await ctx.jobs.list();
          await ctx.workflows.list();
        },
      }),
    );

    await second.running();

    expect(holds(second.core)).toEqual({
      entities: [],
      jobs: [],
      workflows: [],
    });
  });

  it("doesn't count what it claimed and then took back", async () => {
    const { second } = await updated(
      { entities: ["back"], jobs: ["back"], workflows: ["back"] },
      () => ({
        entities: ["back"],
        jobs: ["back"],
        workflows: ["back"],
        then: async (ctx) => {
          await ctx.entities.remove("back");
          await ctx.jobs.cancel("back");
          await ctx.workflows.remove("back");
        },
      }),
    );

    await second.running();

    expect(holds(second.core)).toEqual({
      entities: [],
      jobs: [],
      workflows: [],
    });
  });

  it("writes one row naming the version, what it holds and the update", async () => {
    const { first, second } = await updated({}, () => ({}));
    const before = row(first.core)!;
    expect(before).toMatchObject({ version: "1.0.0", updateId: null });

    await second.running();

    expect(row(second.core)).toMatchObject({
      appId: "test.owner",
      version: "2.0.0",
      digest: expect.any(String),
      updateId: expect.any(String),
    });
  });

  it("is told it came from the version before", async () => {
    const seen: unknown[] = [];
    const first = await supervised(app(() => ({})));
    await first.running();
    const second = await supervised(
      defineApp({
        ...app(() => ({})),
        start: async (_ctx, info) => void seen.push(info),
      }),
      { version: "2.0.0", dataDir: first.core.dataDir },
    );

    await second.running();

    expect(seen).toEqual([{ reason: "updated", from: "1.0.0" }]);
  });

  it("runs the same going back to an older version", async () => {
    const newer = await supervised(
      app(() => ({ entities: ["new", "both"] })),
      {
        version: "2.0.0",
      },
    );
    await newer.running();
    const older = await supervised(
      app(() => ({ entities: ["both"] })),
      {
        version: "1.0.0",
        dataDir: newer.core.dataDir,
      },
    );

    await older.running();

    expect(holds(older.core).entities).toEqual(["both"]);
    expect(row(older.core)).toMatchObject({
      version: "1.0.0",
      updateId: expect.any(String),
    });
  });

  it("takes no calls and runs no jobs until it has committed", async () => {
    let finish!: () => void;
    const held = new Promise<void>((done) => {
      finish = done;
    });
    const { second } = await updated({ jobs: ["kept"] }, () => ({
      jobs: ["kept"],
      then: () => held,
    }));

    await vi.waitFor(() => expect(second.stateOf().state).toBe("starting"));
    expect(second.core.apps.isRunning("test.owner")).toBe(false);

    finish();
    await second.running();

    expect(second.core.apps.isRunning("test.owner")).toBe(true);
  });
});

describe("a start with no change of version", () => {
  it("sweeps nothing", async () => {
    const owned = { entities: ["kept"], jobs: ["kept"], workflows: ["kept"] };
    const first = await supervised(app(() => owned));
    await first.running();

    const again = await supervised(
      app(() => ({})),
      {
        dataDir: first.core.dataDir,
      },
    );
    await again.running();

    expect(holds(again.core)).toEqual({
      entities: ["kept"],
      jobs: ["kept"],
      workflows: ["kept"],
    });
    expect(row(again.core)).toMatchObject({ updateId: null });
  });

  it("nor does a first start", async () => {
    const first = await supervised(app(() => ({ entities: ["kept"] })));

    await first.running();

    expect(holds(first.core).entities).toEqual(["kept"]);
  });
});

describe("an app in the core's process", () => {
  it("sweeps nothing on a new version, since its start isn't asked to say all it owns", async () => {
    const owner = (owned: () => Owned) => ({
      app: app(owned),
      origin: "official" as const,
    });
    const first = await testCore({
      apps: [owner(() => ({ entities: ["kept"], jobs: ["kept"] }))],
    });
    await new Promise((done) => setTimeout(done, 10));
    const next = owner(() => ({}));

    const second = await testCore({
      apps: [{ ...next, app: { ...next.app, version: "2.0.0" } }],
      dataDir: first.dataDir,
    });
    await new Promise((done) => setTimeout(done, 10));

    expect(holds(second).entities).toEqual(["kept"]);
    expect(holds(second).jobs).toEqual(["kept"]);
  });
});

describe("forcing a commit to disk", () => {
  it("is on for that transaction alone, and it can be undone within it", async () => {
    const { db } = await testCore();
    const level = () => db.$client.pragma("synchronous", { simple: true });
    const before = level();

    const during = durably(db, () => level());

    expect(during).toBe(2);
    expect(level()).toBe(before);
  });

  it("goes back to how it was when the work fails, leaving nothing", async () => {
    const core = await testCore();
    const level = () => core.db.$client.pragma("synchronous", { simple: true });
    const before = level();

    expect(() =>
      durably(core.db, () => {
        core.db
          .insert(appVersions)
          .values({ appId: "test.x", version: "1", startedAt: new Date() })
          .run();
        throw new Error("The disk is full");
      }),
    ).toThrow("The disk is full");

    expect(level()).toBe(before);
    expect(core.db.select().from(appVersions).all()).toEqual([]);
  });
});

describe("a job scheduled again as it was", () => {
  const job = (when: unknown, fresh?: boolean) => ({
    key: "kept",
    action: tick.id,
    input: {},
    when: when as never,
    ...(fresh ? { fresh } : {}),
  });
  const inside = () => defineApp({ ...app(() => ({})), start: undefined });
  const home = async () => {
    const pkg = { app: inside(), origin: "official" as const };
    const core = await testCore({ apps: [pkg] });
    return { core, app: pkg.app.id };
  };
  const nextOf = (core: TestCore, id: string) =>
    core.workflows.jobs.list(id)[0]!.nextAt;

  it("keeps its next run, though it's due", async () => {
    const { core, app: id } = await home();
    core.workflows.jobs.schedule(id, job(everyFive));
    const next = nextOf(core, id);

    core.advance(6 * 60_000);
    core.workflows.jobs.schedule(id, job(everyFive));

    expect(nextOf(core, id)).toBe(next);
  });

  it("works it out afresh when asked, as for a new time zone", async () => {
    const { core, app: id } = await home();
    core.workflows.jobs.schedule(id, job(everyFive));
    const next = nextOf(core, id);

    core.advance(6 * 60_000);
    core.workflows.jobs.schedule(id, job(everyFive, true));

    expect(nextOf(core, id)).not.toBe(next);
  });

  it("works it out afresh when its times changed", async () => {
    const { core, app: id } = await home();
    core.workflows.jobs.schedule(id, job(everyFive));
    const next = nextOf(core, id);

    core.workflows.jobs.schedule(id, job({ every: 1_800 }));

    expect(nextOf(core, id)).not.toBe(next);
  });
});
