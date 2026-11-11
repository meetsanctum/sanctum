import {
  defineAction,
  defineApp,
  defineEntityType,
  entityOf,
  type WorkflowGraph,
  type WorkflowProblem,
} from "@meetsanctum/app-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { claimed, get, post, testCore, type TestCore } from "./support.js";
import {
  addWorkflow,
  sample,
  samplePackage,
  noteStep,
  runByHand,
  runsOf,
  steps,
  trigger,
} from "./workflows-support.js";

// Entities as triggers and conditions: the core's `entity` pieces read the
// state the core keeps for each app's entities, by the rules of `device`
// pieces, so no app code runs to match them. Sky publishes its readings from an
// action, as an app would from a poll.

beforeEach(() => sample.reset());

const reading = defineEntityType({
  id: "sky.reading",
  title: "Reading",
  state: z.object({ cloudy: z.boolean(), cover: z.number() }),
});
const wind = defineEntityType({
  id: "sky.wind",
  title: "Wind",
  state: z.object({ cloudy: z.boolean(), cover: z.number() }),
});

const report = defineAction({
  id: "sky.report",
  title: "Report the sky",
  tier: "write",
  input: z.object({
    key: z.string(),
    type: z.enum([reading.id, wind.id]).default(reading.id),
    name: z.string().default("Garden"),
    cloudy: z.boolean(),
    cover: z.number().default(0),
  }),
  output: z.object({}),
  async run(ctx, { key, type, name, cloudy, cover }) {
    await ctx.entities.publish({ type, key, name, state: { cloudy, cover } });
    return {};
  },
});

const forget = defineAction({
  id: "sky.forget",
  title: "Forget a reading",
  tier: "write",
  input: z.object({ key: z.string() }),
  output: z.object({}),
  async run(ctx, { key }) {
    await ctx.entities.remove(key);
    return {};
  },
});

const sky = defineApp({
  id: "test.sky",
  name: "Sky",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [],
  actions: [report, forget],
  events: [],
  provides: { entities: [reading, wind] },
});

async function home() {
  const core = await testCore({
    apps: [samplePackage, { app: sky, origin: "official" }],
  });
  const { token } = await claimed(core);
  return { core, token };
}

async function skyIs(
  core: TestCore,
  token: string,
  body: { key: string; cloudy: boolean } & Record<string, unknown>,
) {
  const response = await post(
    core,
    "/api/apps/test.sky/actions/sky.report",
    body,
    { token },
  );
  expect(response.statusCode).toBe(200);
  await core.workflows.settled();
}

async function forgotten(core: TestCore, token: string, key: string) {
  const response = await post(
    core,
    "/api/apps/test.sky/actions/sky.forget",
    { key },
    { token },
  );
  expect(response.statusCode).toBe(200);
  await core.workflows.settled();
}

const garden = { app: "test.sky", key: "garden" };

describe("entity triggers", () => {
  it("fire when the field changes to a value that passes", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      runMode: "parallel",
      graph: steps(
        trigger("cloudy", "entity", {
          ...garden,
          field: "cloudy",
          operator: "is_on",
        }),
        noteStep("note"),
      ),
    });

    // Clear at first, which does not pass, then cloudy.
    await skyIs(core, token, { key: "garden", cloudy: false, cover: 10 });
    await skyIs(core, token, { key: "garden", cloudy: true, cover: 80 });
    // Another field changes, and another entity turns cloudy.
    await skyIs(core, token, { key: "garden", cloudy: true, cover: 90 });
    await skyIs(core, token, { key: "roof", cloudy: true });

    const runs = await runsOf(core, token, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toMatchObject({
      nodes: ["cloudy"],
      data: {
        type: "sky.reading",
        app: "test.sky",
        key: "garden",
        before: { cloudy: false, cover: 10 },
        after: { cloudy: true, cover: 80 },
      },
    });
    expect(sample.noted).toHaveLength(1);
  });

  it("fire nothing for a state that repeats, however it is published", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      runMode: "parallel",
      graph: steps(trigger("any", "entity", garden), noteStep("note")),
    });

    await skyIs(core, token, { key: "garden", cloudy: false });
    // The same state again, then under another name.
    await skyIs(core, token, { key: "garden", cloudy: false });
    await skyIs(core, token, { key: "garden", cloudy: false, name: "Lawn" });
    await skyIs(core, token, { key: "garden", cloudy: true });

    const runs = await runsOf(core, token, id);
    expect(runs.map((run) => run.trigger.data)).toEqual([
      expect.objectContaining({ after: { cloudy: true, cover: 0 } }),
      expect.objectContaining({ before: null }),
    ]);
  });

  it("fire nothing when the entity goes", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      runMode: "parallel",
      graph: steps(trigger("any", "entity", garden), noteStep("note")),
    });

    await skyIs(core, token, { key: "garden", cloudy: true });
    await forgotten(core, token, "garden");
    await core.apps.remove("test.sky");
    await core.workflows.settled();

    expect(await runsOf(core, token, id)).toHaveLength(1);
  });

  it("fire for every entity of a type, and only that type", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      runMode: "parallel",
      graph: steps(
        trigger("cloudy", "entity", {
          type: "sky.reading",
          field: "cloudy",
          operator: "equals",
          value: true,
        }),
        noteStep("note"),
      ),
    });

    await skyIs(core, token, { key: "garden", cloudy: true });
    await skyIs(core, token, { key: "gust", type: "sky.wind", cloudy: true });
    // A key that changes type is a new entity of the type it has now.
    await skyIs(core, token, { key: "gust", cloudy: true });

    const runs = await runsOf(core, token, id);
    expect(
      runs.map(({ trigger: { data } }) => data as { key: string }),
    ).toEqual([
      expect.objectContaining({ key: "gust", before: null }),
      expect.objectContaining({ key: "garden", type: "sky.reading" }),
    ]);
  });

  it("start one run of a workflow, however many of its triggers match", async () => {
    const { core, token } = await home();
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        trigger("one", "entity", garden),
        trigger("all", "entity", { type: "sky.reading" }),
        noteStep("note"),
      ],
      edges: [
        { from: "one", to: "note" },
        { from: "all", to: "note" },
      ],
    };
    const { id } = await addWorkflow(core, token, {
      runMode: "parallel",
      graph,
    });

    await skyIs(core, token, { key: "garden", cloudy: true });

    const runs = await runsOf(core, token, id);
    expect(runs.map((run) => run.trigger.nodes)).toEqual([["one", "all"]]);
    expect(sample.noted).toHaveLength(1);
  });

  it("leave the publication alone when a workflow fails on it", async () => {
    const { core, token } = await home();
    vi.spyOn(core.workflows, "entityChanged").mockImplementation(() => {
      throw new Error("the rules fell over");
    });

    await skyIs(core, token, { key: "garden", cloudy: true });

    expect(core.entities.get("test.sky", "garden")?.state).toEqual({
      cloudy: true,
      cover: 0,
    });
    expect(core.logs).toContain(
      "workflows: a change of test.sky's garden was not handled (the rules fell over)",
    );
  });
});

describe("entity conditions", () => {
  async function checking(
    core: TestCore,
    token: string,
    config: Record<string, unknown>,
  ) {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        trigger("t", "manual"),
        { id: "c", kind: "condition", piece: "entity", config },
        noteStep("note"),
      ],
      edges: [
        { from: "t", to: "c" },
        { from: "c", to: "note" },
      ],
    };
    const { id } = await addWorkflow(core, token, { graph });
    return async () => {
      await runByHand(core, token, id);
      await core.workflows.settled();
      const [run] = await runsOf(core, token, id);
      return run!.status === "skipped" ? run!.reason : run!.status;
    };
  }

  it("pass while one entity's state passes, and fail otherwise", async () => {
    const { core, token } = await home();
    const run = await checking(core, token, {
      ...garden,
      field: "cover",
      operator: "not_equals",
      value: 0,
    });

    await skyIs(core, token, { key: "garden", cloudy: false });
    expect(await run()).toBe("conditions");
    await skyIs(core, token, { key: "garden", cloudy: true, cover: 70 });
    expect(await run()).toBe("succeeded");
  });

  it("pass for a type while any of its entities passes", async () => {
    const { core, token } = await home();
    const run = await checking(core, token, {
      type: "sky.reading",
      field: "cloudy",
      operator: "is_on",
    });

    expect(await run()).toBe("conditions");
    await skyIs(core, token, { key: "gust", type: "sky.wind", cloudy: true });
    await skyIs(core, token, { key: "garden", cloudy: false });
    expect(await run()).toBe("conditions");
    await skyIs(core, token, { key: "roof", cloudy: true });
    expect(await run()).toBe("succeeded");
  });

  it("cannot run for an entity of another type than the one named", async () => {
    const { core, token } = await home();
    const run = await checking(core, token, {
      ...garden,
      type: "sky.wind",
      field: "cloudy",
      operator: "is_on",
    });

    await skyIs(core, token, { key: "garden", cloudy: true });
    expect(await run()).toBe("broken");
  });
});

describe("saving an entity piece", () => {
  async function saved(
    core: TestCore,
    token: string,
    config: Record<string, unknown>,
  ) {
    const response = await post(
      core,
      "/api/workflows/add",
      {
        name: "Sky",
        graph: steps(trigger("t", "entity", config), noteStep("note")),
      },
      { token },
    );
    return response.json() as {
      problems?: WorkflowProblem[];
      warnings?: string[];
    };
  }

  it("refuses a type that is neither standard nor brought by an installed app", async () => {
    const { core, token } = await home();
    expect(await saved(core, token, { type: "nope.thing" })).toEqual({
      error: "invalid_workflow",
      problems: [
        {
          node: "t",
          field: "type",
          message: "There is no entity type nope.thing",
        },
      ],
    });
    expect(
      (await saved(core, token, { type: "sky.reading" })).warnings,
    ).toEqual([]);
  });

  it("warns that a type no installed app brings waits for one", async () => {
    const { core, token } = await home();
    expect(
      (await saved(core, token, { type: "weather.forecast" })).warnings,
    ).toEqual(["entity: weather.forecast waits for an app that brings it"]);

    const { id } = await addWorkflow(core, token, {
      graph: steps(
        trigger("t", "entity", { type: "sky.reading" }),
        noteStep("note"),
      ),
    });
    await core.apps.remove("test.sky");
    const listed = (
      await post(core, "/api/workflows/update", { id }, { token })
    ).json() as { problems: WorkflowProblem[]; warnings: string[] };
    expect(listed).toMatchObject({
      problems: [],
      warnings: ["entity: sky.reading waits for an app that brings it"],
    });
  });

  it("takes an app only with a key, and a condition only for an entity or a type", async () => {
    const { core, token } = await home();
    expect(
      (await saved(core, token, { app: "test.sky", type: "sky.reading" }))
        .problems,
    ).toEqual([
      { node: "t", field: null, message: "An app and a key go together" },
    ]);

    const condition = await post(
      core,
      "/api/workflows/add",
      {
        name: "Sky",
        graph: {
          version: 1,
          nodes: [
            trigger("t", "manual"),
            {
              id: "c",
              kind: "condition",
              piece: "entity",
              config: { field: "cloudy", operator: "is_on" },
            },
            noteStep("note"),
          ],
          edges: [
            { from: "t", to: "c" },
            { from: "c", to: "note" },
          ],
        },
      },
      { token },
    );
    expect(condition.json().problems).toEqual([
      { node: "c", field: null, message: "Name an entity or a type" },
    ]);
  });
});

describe("an entity that's gone", () => {
  const problemsOf = async (core: TestCore, token: string, id: string) =>
    (
      (await get(core, "/api/workflows", { token })).json() as {
        id: string;
        problems: WorkflowProblem[];
      }[]
    ).find((each) => each.id === id)!.problems;

  const removed = {
    field: "key",
    message: "The reading it names was removed",
  };

  it("keeps a condition naming it from running, and says so, until it's back", async () => {
    const { core, token } = await home();
    await skyIs(core, token, { key: "garden", cloudy: true });
    const { id } = await addWorkflow(core, token, {
      graph: steps(
        trigger("t", "manual"),
        {
          id: "check",
          kind: "condition",
          piece: "entity",
          config: {
            ...garden,
            type: reading.id,
            field: "cloudy",
            operator: "is_on",
          },
        },
        noteStep("note"),
      ),
    });
    expect(await problemsOf(core, token, id)).toEqual([]);

    await forgotten(core, token, "garden");

    expect(await problemsOf(core, token, id)).toEqual([
      { node: "check", ...removed },
    ]);
    expect((await runByHand(core, token, id)).json()).toMatchObject({
      status: "skipped",
      reason: "broken",
      error: removed.message,
    });

    await skyIs(core, token, { key: "garden", cloudy: true });
    expect(await problemsOf(core, token, id)).toEqual([]);
  });

  it("says so for a trigger naming it, which would never fire", async () => {
    const { core, token } = await home();
    await skyIs(core, token, { key: "garden", cloudy: true });
    const { id } = await addWorkflow(core, token, {
      graph: steps(
        trigger("t", "entity", { ...garden, type: reading.id }),
        noteStep("note"),
      ),
    });

    await forgotten(core, token, "garden");

    expect(await problemsOf(core, token, id)).toEqual([
      { node: "t", ...removed },
    ]);
  });

  it.each(["trigger", "condition"] as const)(
    "stays broken when its %s's entity comes back as another type",
    async (kind) => {
      const { core, token } = await home();
      await skyIs(core, token, { key: "garden", cloudy: true });
      const named = {
        id: "named",
        kind,
        piece: "entity",
        config: {
          ...garden,
          type: reading.id,
          field: "cloudy",
          operator: "is_on",
        },
      };
      const { id } = await addWorkflow(core, token, {
        graph:
          kind === "trigger"
            ? steps(named, noteStep("note"))
            : steps(trigger("t", "manual"), named, noteStep("note")),
      });

      await forgotten(core, token, "garden");
      await skyIs(core, token, { key: "garden", type: wind.id, cloudy: true });

      expect(await problemsOf(core, token, id)).toEqual([
        { node: "named", ...removed },
      ]);
      expect((await runByHand(core, token, id)).json()).toMatchObject({
        status: "skipped",
        reason: "broken",
      });

      await skyIs(core, token, { key: "garden", cloudy: true });
      expect(await problemsOf(core, token, id)).toEqual([]);
      if (kind === "condition") await runByHand(core, token, id);
      await core.workflows.settled();
      expect((await runsOf(core, token, id))[0]).toMatchObject({
        status: "succeeded",
      });
    },
  );

  it("calls it what its type is called, or an item once nothing brings that", async () => {
    const { core, token } = await home();
    await skyIs(core, token, { key: "garden", cloudy: true });
    const { id } = await addWorkflow(core, token, {
      graph: steps(trigger("t", "entity", garden), noteStep("note")),
    });

    await forgotten(core, token, "garden");

    expect(await problemsOf(core, token, id)).toEqual([
      {
        node: "t",
        field: "key",
        message: "The item it names was removed",
      },
    ]);
  });

  it("doesn't count for one that means any of a type", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      graph: steps(
        trigger("t", "entity", { type: reading.id }),
        noteStep("note"),
      ),
    });

    expect(await problemsOf(core, token, id)).toEqual([]);
  });

  describe("named by an app's step", () => {
    const chart = defineAction({
      id: "sky.chart",
      title: "Chart a reading",
      tier: "write",
      input: z.object({ reading: entityOf(reading.id) }),
      output: z.object({}),
      run: async () => ({}),
    });
    const withStep = {
      ...sky,
      actions: [report, forget, chart],
      provides: { ...sky.provides, steps: [chart] },
    };
    const stepHome = async () => {
      const core = await testCore({
        apps: [samplePackage, { app: withStep, origin: "official" }],
      });
      const { token } = await claimed(core);
      return { core, token };
    };
    const charting = {
      id: "chart",
      kind: "step" as const,
      app: "test.sky",
      piece: "sky.chart",
      config: { reading: "garden" },
    };

    it("can be saved before the app has published it, as an app's start may", async () => {
      const { core, token } = await stepHome();

      const response = await post(
        core,
        "/api/workflows/add",
        { name: "Chart", graph: steps(trigger("t", "manual"), charting) },
        { token },
      );

      expect(response.statusCode).toBe(200);
    });

    it("keeps it from running once it's gone, with the field to change", async () => {
      const { core, token } = await stepHome();
      await skyIs(core, token, { key: "garden", cloudy: true });
      const { id } = await addWorkflow(core, token, {
        graph: steps(trigger("t", "manual"), charting),
      });
      expect(await problemsOf(core, token, id)).toEqual([]);

      await forgotten(core, token, "garden");

      expect(await problemsOf(core, token, id)).toEqual([
        {
          node: "chart",
          field: "reading",
          message: "The reading it names was removed",
        },
      ]);
      expect((await runByHand(core, token, id)).json()).toMatchObject({
        status: "skipped",
        reason: "broken",
      });
    });

    it("isn't met by an entity of another type with that key", async () => {
      const { core, token } = await stepHome();
      await skyIs(core, token, { key: "garden", cloudy: true });
      const { id } = await addWorkflow(core, token, {
        graph: steps(trigger("t", "manual"), charting),
      });

      await forgotten(core, token, "garden");
      await skyIs(core, token, { key: "garden", type: wind.id, cloudy: true });

      expect(await problemsOf(core, token, id)).toHaveLength(1);
    });
  });
});
