import { beforeEach, describe, expect, it, vi } from "vitest";

import { keptRuns } from "../src/workflows/runs.js";
import { lampsCore, radio, settled } from "./devices-support.js";
import { get, post, testCore } from "./support.js";
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

// Running workflows: v1's engine semantics (test/automation-engine.test.ts,
// Pragmata v1-final), app events and device changes as triggers, steps as the
// workflow, run modes, loops, history and workflows whose pieces are missing.

beforeEach(() => sample.reset());

async function home() {
  const { core, maya, lamp, plug } = await lampsCore({ apps: [samplePackage] });
  return { core, maya, lamp, plug, token: maya.token };
}

describe("a run", () => {
  it("runs only the steps whose condition paths pass", async () => {
    const { core, token, lamp } = await home();
    // The lamp is off, so the condition fails and only mood-b runs (v1's
    // "runs only action branches with passing condition paths").
    const { id } = await addWorkflow(core, token, {
      runMode: "parallel",
      graph: {
        version: 1,
        nodes: [
          trigger("trigger", "manual"),
          {
            id: "condition",
            kind: "condition",
            piece: "device",
            config: {
              device: lamp,
              field: "on",
              operator: "equals",
              value: true,
            },
          },
          noteStep("mood-a"),
          noteStep("mood-b"),
        ],
        edges: [
          { from: "trigger", to: "condition" },
          { from: "condition", to: "mood-a" },
          { from: "trigger", to: "mood-b" },
        ],
      },
    });

    expect((await runByHand(core, token, id)).statusCode).toBe(200);
    await core.workflows.settled();

    expect(sample.noted.map(({ text }) => text)).toEqual(["mood-b"]);
    const [run] = await runsOf(core, token, id);
    expect(run!.status).toBe("succeeded");
    expect(run!.steps.map((step) => [step.node, step.status])).toEqual([
      ["condition", "skipped"],
      ["mood-b", "succeeded"],
    ]);
  });

  it("checks an app's condition once, and is skipped when no step passes", async () => {
    const { core, token } = await home();
    const isDue = {
      id: "due",
      kind: "condition" as const,
      app: "test.sample",
      piece: "sample.isDue",
      config: { task: "bins" },
    };
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [trigger("t", "manual"), isDue, noteStep("a"), noteStep("b")],
        edges: [
          { from: "t", to: "due" },
          { from: "due", to: "a" },
          { from: "due", to: "b" },
        ],
      },
    });

    await runByHand(core, token, id);
    await core.workflows.settled();
    sample.due.add("bins");
    await runByHand(core, token, id);
    await core.workflows.settled();

    const [second, first] = await runsOf(core, token, id);
    expect(first).toMatchObject({ status: "skipped", reason: "conditions" });
    expect(first!.steps.map((step) => step.status)).toEqual(["skipped"]);
    expect(second!.status).toBe("succeeded");
    expect(second!.steps.map((step) => step.node)).toEqual(["due", "a", "b"]);
  });

  it("calls steps as the workflow, at the everyday tiers only", async () => {
    const { core, token } = await home();
    const added = await addWorkflow(core, token, {
      graph: steps(trigger("t", "manual"), noteStep("note"), {
        id: "wipe",
        kind: "step",
        app: "test.sample",
        piece: "sample.wipe",
        config: {},
      }),
    });
    expect(added.warnings).toEqual([
      "sample.wipe needs a person's approval each time, so a workflow can't run it",
    ]);

    await runByHand(core, token, added.id);
    await core.workflows.settled();

    expect(sample.noted[0]!.actor).toEqual({ kind: "workflow", id: added.id });
    const [run] = await runsOf(core, token, added.id);
    expect(run!.status).toBe("partial");
    expect(run!.steps.map((step) => [step.status, step.error])).toEqual([
      ["succeeded", null],
      ["failed", "needs_approval"],
    ]);
    const logged = core.activity
      .recent()
      .filter((entry) => entry.source === "test.sample");
    expect(
      logged.map(({ action, outcome, actor }) => ({ action, outcome, actor })),
    ).toEqual(
      expect.arrayContaining([
        {
          action: "sample.note",
          outcome: "ok",
          actor: `workflow:${added.id}`,
        },
        {
          action: "sample.wipe",
          outcome: "refused",
          actor: `workflow:${added.id}`,
        },
      ]),
    );
  });

  it("commands a device as the workflow", async () => {
    const { core, token, lamp } = await home();
    const { id } = await addWorkflow(core, token, {
      graph: steps(trigger("t", "manual"), {
        id: "on",
        kind: "step",
        piece: "device",
        config: { device: lamp, capability: "light", command: { on: true } },
      }),
    });
    // The lamp never says what it did, so the step's output is what was sent.
    radio.confirms = false;

    await runByHand(core, token, id);
    await core.workflows.settled();

    expect(radio.received.map(({ actor }) => actor)).toEqual([
      { kind: "workflow", id },
    ]);
    const [run] = await runsOf(core, token, id);
    expect(run!.steps[0]).toMatchObject({
      status: "succeeded",
      output: { device: lamp, capability: "light", sync: "pending" },
    });
  });
});

describe("app events", () => {
  async function onDone(config: Record<string, unknown>) {
    const context = await home();
    const { id } = await addWorkflow(context.core, context.token, {
      runMode: "parallel",
      graph: steps(
        trigger("done", "sample.done", config, "test.sample"),
        noteStep("note"),
      ),
    });
    const finish = (input: object) =>
      post(context.core, "/api/apps/test.sample/actions/sample.finish", input, {
        token: context.token,
      });
    return { ...context, id, finish };
  }

  it("start the workflows whose triggers' configs match them", async () => {
    const { core, token, id, finish } = await onDone({ room: "kitchen" });

    await finish({ task: "dishes", room: "kitchen" });
    await finish({ task: "hoover", room: "hall" });
    await core.workflows.settled();

    const runs = await runsOf(core, token, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toMatchObject({
      nodes: ["done"],
      data: {
        event: "sample.done",
        payload: { task: "dishes", room: "kitchen" },
      },
    });
  });

  it("start one run of a workflow, however many of its triggers match", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("any", "sample.done", {}, "test.sample"),
          trigger("dishes", "sample.done", { task: "dishes" }, "test.sample"),
          noteStep("note"),
        ],
        edges: [
          { from: "any", to: "note" },
          { from: "dishes", to: "note" },
        ],
      },
    });

    await post(
      core,
      "/api/apps/test.sample/actions/sample.finish",
      { task: "dishes", room: "kitchen" },
      { token },
    );
    await core.workflows.settled();

    const runs = await runsOf(core, token, id);
    expect(runs.map((run) => run.trigger.nodes)).toEqual([["any", "dishes"]]);
    expect(sample.noted).toHaveLength(1);
  });

  it("go nowhere from a call that failed", async () => {
    const { core, token, id, finish } = await onDone({});

    expect(
      (await finish({ task: "dishes", room: "kitchen", fail: true }))
        .statusCode,
    ).toBe(500);
    await core.workflows.settled();

    expect(await runsOf(core, token, id)).toEqual([]);
  });

  it("do not start a workflow that is off", async () => {
    const { core, token, id, finish } = await onDone({});
    await post(
      core,
      "/api/workflows/update",
      { id, enabled: false },
      { token },
    );

    await finish({ task: "dishes", room: "kitchen" });
    await core.workflows.settled();

    expect(await runsOf(core, token, id)).toEqual([]);
  });
});

describe("device changes", () => {
  it("fire when the reported field changes to a value that passes", async () => {
    const { core, token, lamp } = await home();
    const { id } = await addWorkflow(core, token, {
      runMode: "parallel",
      graph: steps(
        trigger("on", "device", {
          device: lamp,
          field: "on",
          operator: "is_on",
        }),
        noteStep("note"),
      ),
    });

    await radio.press("lamp-1", { on: true });
    await settled();
    // The same state again, then a change of another field.
    await radio.press("lamp-1", { on: true });
    await radio.press("lamp-1", { brightness: 40 });
    await settled();
    await core.workflows.settled();

    const runs = await runsOf(core, token, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger.data).toMatchObject({
      device: lamp,
      capability: "light",
      kind: "light",
      before: { on: false },
      after: { on: true },
    });
  });

  it("fire for any device of a kind", async () => {
    const { core, token, plug } = await home();
    const { id } = await addWorkflow(core, token, {
      graph: steps(
        trigger("switch", "device", { kind: "switch", field: "on" }),
        noteStep("note"),
      ),
    });

    await radio.press("lamp-1", { on: true });
    await radio.press("plug-1", { on: true });
    await settled();
    await core.workflows.settled();

    const runs = await runsOf(core, token, id);
    expect(
      runs.map((run) => (run.trigger.data as { device: string }).device),
    ).toEqual([plug]);
  });
});

describe("run modes", () => {
  async function held(runMode: string) {
    const context = await home();
    const { id } = await addWorkflow(context.core, context.token, {
      runMode,
      graph: steps(
        trigger("t", "manual"),
        noteStep("first"),
        noteStep("second"),
      ),
    });
    const release = sample.holdSteps();
    const start = async () =>
      (await runByHand(context.core, context.token, id)).json() as {
        id: string;
        status: string;
      };
    return { ...context, id, release, start };
  }

  it("single: skips a trigger while a run is going", async () => {
    const { core, token, id, release, start } = await held("single");
    await start();
    expect(await start()).toMatchObject({ status: "skipped", reason: "busy" });
    release();
    await core.workflows.settled();
    expect((await runsOf(core, token, id)).map((run) => run.status)).toEqual([
      "skipped",
      "succeeded",
    ]);
  });

  it("queued: runs one at a time, in order", async () => {
    const { core, token, id, release, start } = await held("queued");
    const first = await start();
    const second = await start();
    expect(second.status).toBe("queued");
    expect(sample.noted).toHaveLength(1);
    release();
    await core.workflows.settled();
    const runs = await runsOf(core, token, id);
    expect(runs.map((run) => [run.id, run.status])).toEqual([
      [second.id, "succeeded"],
      [first.id, "succeeded"],
    ]);
    expect(sample.noted.map(({ text }) => text)).toEqual([
      "first",
      "second",
      "first",
      "second",
    ]);
  });

  it("restart: cancels the running run, which lets its call finish", async () => {
    const { core, token, id, release, start } = await held("restart");
    const first = await start();
    const second = await start();
    release();
    await core.workflows.settled();
    const runs = await runsOf(core, token, id);
    expect(runs.find((run) => run.id === first.id)).toMatchObject({
      status: "cancelled",
      reason: "restarted",
    });
    // The cancelled run finished its call to "first" and went no further.
    expect(
      runs.find((run) => run.id === first.id)!.steps.map((step) => step.node),
    ).toEqual(["first"]);
    expect(runs.find((run) => run.id === second.id)!.status).toBe("succeeded");
  });

  it("parallel: runs every trigger at once", async () => {
    const { core, release, start } = await held("parallel");
    await start();
    await start();
    await vi.waitFor(() => expect(sample.noted).toHaveLength(2));
    release();
    await core.workflows.settled();
    expect(sample.noted).toHaveLength(4);
  });
});

describe("a workflow that keeps triggering", () => {
  it("has its runs skipped beyond 30 a minute, until the minute is over", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      runMode: "parallel",
      graph: steps(trigger("t", "manual"), noteStep("note")),
    });

    for (let run = 0; run < 31; run++) {
      await runByHand(core, token, id);
    }
    await core.workflows.settled();
    expect((await runsOf(core, token, id))[0]).toMatchObject({
      status: "skipped",
      reason: "too_often",
    });

    core.advance(60_000);
    expect((await runByHand(core, token, id)).json().status).toBe("running");
    await core.workflows.settled();
  });
});

describe("history", () => {
  it(`keeps a workflow's latest ${keptRuns} runs`, async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      graph: steps(trigger("t", "manual"), noteStep("note")),
    });

    for (let run = 0; run < keptRuns + 5; run++) {
      core.advance(3_000);
      await runByHand(core, token, id);
      await core.workflows.settled();
    }

    const runs = await runsOf(core, token, id);
    expect(runs).toHaveLength(keptRuns);
    expect(sample.noted).toHaveLength(keptRuns + 5);
  });
});

describe("a workflow whose app is gone", () => {
  it("is kept as it was, lists what is missing and does not run", async () => {
    const { core, token } = await home();
    const graph = steps(trigger("t", "manual"), noteStep("note"));
    const { id } = await addWorkflow(core, token, { graph });

    await core.apps.remove("test.sample");
    const listed = (await get(core, "/api/workflows", { token })).json();
    expect(listed[0]).toMatchObject({
      id,
      graph,
      problems: [
        {
          node: "note",
          field: null,
          message: "The app test.sample is not installed, for sample.note",
        },
      ],
    });

    expect((await runByHand(core, token, id)).json()).toMatchObject({
      status: "skipped",
      reason: "broken",
      error: "The app test.sample is not installed, for sample.note",
    });
    expect(sample.noted).toEqual([]);

    // It can be switched off, but its graph only saved whole.
    expect(
      (
        await post(
          core,
          "/api/workflows/update",
          { id, enabled: false },
          { token },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await post(
          core,
          "/api/workflows/update",
          { id, graph: { ...graph, edges: [] } },
          { token },
        )
      ).statusCode,
    ).toBe(400);
  });

  it("runs again once the app is back", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      graph: steps(trigger("t", "manual"), noteStep("note")),
    });

    await core.apps.remove("test.sample");
    await core.startApps([samplePackage]);

    expect((await runByHand(core, token, id)).json().status).toBe("running");
    await core.workflows.settled();
    expect(sample.noted).toHaveLength(1);
  });
});

describe("a core that stopped mid-run", () => {
  it("ends the runs it was running as interrupted, and runs none again", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      graph: steps(trigger("t", "manual"), noteStep("note")),
    });
    const release = sample.holdSteps();
    await runByHand(core, token, id);

    // A new core on the same data, as after a restart.
    const restarted = await testCore({
      dataDir: core.dataDir,
      apps: [samplePackage],
    });
    const runs = await runsOf(restarted, token, id);
    expect(runs[0]).toMatchObject({ status: "failed", reason: "interrupted" });
    expect(runs[0]!.steps[0]).toMatchObject({
      status: "failed",
      error: "interrupted",
    });

    release();
    await core.workflows.settled();
  });
});
