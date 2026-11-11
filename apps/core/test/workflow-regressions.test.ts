import { defineAction, defineApp } from "@meetsanctum/app-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { SunDays } from "../src/workflows/jobs.js";
import { keptRuns } from "../src/workflows/runs.js";
import { claimed, post, testCore } from "./support.js";
import {
  addWorkflow,
  sample,
  samplePackage,
  noteStep,
  runByHand,
  steps,
  trigger,
} from "./workflows-support.js";

beforeEach(() => sample.reset());

describe("run lifetime", () => {
  it("waits for every active run after switching from parallel to queued", async () => {
    const core = await testCore({ apps: [samplePackage] });
    const { token } = await claimed(core);
    const { id } = await addWorkflow(core, token, {
      runMode: "parallel",
      graph: steps(trigger("t", "manual"), noteStep("note")),
    });
    const releaseFirst = sample.holdSteps();
    await runByHand(core, token, id);
    const releaseSecond = sample.holdSteps();
    const second = (await runByHand(core, token, id)).json();
    await post(
      core,
      "/api/workflows/update",
      { id, runMode: "queued" },
      { token },
    );
    const queued = (await runByHand(core, token, id)).json();
    try {
      releaseFirst();
      // Let the first call finish without releasing the second one.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(core.workflows.run(second.id)?.status).toBe("running");
      expect(core.workflows.run(queued.id)?.status).toBe("queued");
      expect(sample.noted).toHaveLength(2);
    } finally {
      releaseFirst();
      releaseSecond();
      await core.workflows.settled();
    }
    expect(core.workflows.run(queued.id)?.status).toBe("succeeded");
    expect(sample.noted).toHaveLength(3);
  });

  it("keeps active and queued runs when skipped runs fill the history", async () => {
    const core = await testCore({ apps: [samplePackage] });
    const { token } = await claimed(core);
    const { id } = await addWorkflow(core, token, {
      runMode: "queued",
      graph: steps(trigger("t", "manual"), noteStep("first"), noteStep("last")),
    });
    const release = sample.holdSteps();
    const first = (await runByHand(core, token, id)).json();
    const second = (await runByHand(core, token, id)).json();
    try {
      for (let index = 0; index < keptRuns + 30; index++) {
        await runByHand(core, token, id);
      }
      expect(core.workflows.run(first.id)?.status).toBe("running");
      expect(core.workflows.run(second.id)?.status).toBe("queued");
    } finally {
      release();
      await core.workflows.settled();
    }
    expect(sample.noted.filter(({ text }) => text === "last")).toHaveLength(30);
    expect(core.logs.filter((message) => message.includes("a run of"))).toEqual(
      [],
    );
    expect(core.workflows.runs(id)).toHaveLength(keptRuns);
  });

  it("checks missing pieces again before starting a queued run", async () => {
    const core = await testCore({ apps: [samplePackage] });
    const { token } = await claimed(core);
    const { id } = await addWorkflow(core, token, {
      runMode: "queued",
      graph: steps(trigger("t", "manual"), noteStep("note")),
    });
    const release = sample.holdSteps();
    await runByHand(core, token, id);
    const queued = (await runByHand(core, token, id)).json();
    // Removing it lets the step under way finish first.
    const removing = core.apps.remove("test.sample");
    release();
    await removing;
    await core.workflows.settled();
    expect(core.workflows.run(queued.id)).toMatchObject({
      status: "skipped",
      reason: "broken",
      steps: [],
    });
  });
});

describe("action input", () => {
  it("passes the original config to the host for conditions and steps", async () => {
    const received: number[] = [];
    const input = z.object({
      amount: z.number().transform((amount) => amount + 1),
    });
    const condition = defineAction({
      id: "inputs.check",
      title: "Check an amount",
      tier: "read",
      input,
      output: z.boolean(),
      async run(_ctx, config) {
        received.push(config.amount);
        return true;
      },
    });
    const step = defineAction({
      id: "inputs.note",
      title: "Note an amount",
      tier: "write",
      input,
      output: z.number(),
      async run(_ctx, config) {
        received.push(config.amount);
        return config.amount;
      },
    });
    const app = defineApp({
      id: "test.inputs",
      name: "Inputs",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [],
      actions: [condition, step],
      events: [],
      provides: { conditions: [condition], steps: [step] },
    });
    const core = await testCore({ apps: [{ app, origin: "official" }] });
    const { token } = await claimed(core);
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("t", "manual"),
          {
            id: "c",
            kind: "condition",
            app: app.id,
            piece: condition.id,
            config: { amount: 1 },
          },
          {
            id: "s",
            kind: "step",
            app: app.id,
            piece: step.id,
            config: { amount: 1 },
          },
        ],
        edges: [
          { from: "t", to: "c" },
          { from: "c", to: "s" },
        ],
      },
    });
    await runByHand(core, token, id);
    await core.workflows.settled();
    expect(received).toEqual([2, 2]);
  });

  it("preserves null and omitted job inputs across a restart", async () => {
    const received: unknown[] = [];
    const action = defineAction({
      id: "inputs.note",
      title: "Note input",
      tier: "write",
      input: z.null().optional(),
      output: z.object({}),
      async run(_ctx, input) {
        received.push(input);
        return {};
      },
    });
    const app = defineApp({
      id: "test.inputs",
      name: "Inputs",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [],
      actions: [action],
      events: [],
    });
    const apps = [{ app, origin: "official" as const }];
    const core = await testCore({ apps });
    for (const [key, input] of [
      ["null", null],
      ["omitted", undefined],
    ] as const) {
      core.workflows.jobs.schedule(app.id, {
        key,
        action: action.id,
        input,
        when: { at: "2026-10-26T13:00:00Z" },
      });
    }
    const again = await testCore({
      apps,
      dataDir: core.dataDir,
      startsAt: "2026-10-26T13:00:00Z",
    });
    again.workflows.tick();
    await again.workflows.settled();
    expect(received).toEqual([null, undefined]);
    expect(again.workflows.jobs.list(app.id)).toEqual([]);
  });
});

describe("job scheduling", () => {
  it("keeps a replacement one-off job until the earlier call finishes", async () => {
    const core = await testCore({ apps: [samplePackage] });
    const schedule = (text: string) =>
      core.workflows.jobs.schedule("test.sample", {
        key: "note",
        action: "sample.note",
        input: { text },
        when: { at: "2026-10-26T12:00:00Z" },
      });
    const release = sample.holdSteps();
    schedule("first");
    core.workflows.tick();
    schedule("replacement");
    core.workflows.tick();
    release();
    await core.workflows.settled();
    core.workflows.tick();
    await core.workflows.settled();
    expect(sample.noted.map(({ text }) => text)).toEqual([
      "first",
      "replacement",
    ]);
  });

  it("refreshes future sun timers and pauses them when sun data goes away", async () => {
    const sunset = (at: string) => [
      { date: "2026-10-26", sunrise: null, sunset: `2026-10-26T${at}:00Z` },
    ];
    let sun: SunDays | null = sunset("13:00");
    const core = await testCore({ apps: [samplePackage], sun: () => sun });
    const { token } = await claimed(core);
    await addWorkflow(core, token, {
      graph: steps(trigger("t", "sun", { event: "sunset" }), noteStep("sun")),
    });
    core.workflows.jobs.schedule("test.sample", {
      key: "sun",
      action: "sample.tick",
      input: {},
      when: { sun: "sunset" },
    });
    sun = sunset("14:00");
    core.workflows.tick();
    core.advance(60 * 60_000);
    core.workflows.tick();
    await core.workflows.settled();
    expect(sample.noted).toEqual([]);
    expect(sample.ticks).toEqual([]);

    sun = null;
    core.workflows.tick();
    core.advance(60 * 60_000);
    core.workflows.tick();
    await core.workflows.settled();
    expect(sample.noted).toEqual([]);
    expect(sample.ticks).toEqual([]);

    sun = sunset("15:00");
    core.workflows.tick();
    core.advance(60 * 60_000);
    core.workflows.tick();
    await core.workflows.settled();
    expect(sample.noted).toHaveLength(1);
    expect(sample.ticks).toHaveLength(1);
  });
});

describe("graph complexity", () => {
  it("runs a graph whose branches multiply its paths, checking each condition once", async () => {
    const core = await testCore({ apps: [samplePackage] });
    const { token } = await claimed(core);
    const nodes = [trigger("t", "manual"), noteStep("s")];
    const edges: { from: string; to: string }[] = [];
    let previous = ["t"];
    // 40 levels of two conditions each: 2^40 paths from the trigger to s.
    for (let level = 0; level < 40; level++) {
      const current = [`left-${level}`, `right-${level}`];
      for (const id of current) {
        nodes.push({
          id,
          kind: "condition",
          piece: "time",
          config: { after: "00:00", before: "23:59" },
        });
        for (const from of previous) edges.push({ from, to: id });
      }
      previous = current;
    }
    for (const from of previous) edges.push({ from, to: "s" });
    const { id } = await addWorkflow(core, token, {
      graph: { version: 1, nodes, edges },
    });

    await runByHand(core, token, id);
    await core.workflows.settled();

    const [run] = core.workflows.runs(id);
    expect(run!.status).toBe("succeeded");
    // Each search stops at the first path that passes: one condition a level.
    expect(run!.steps.filter((step) => step.kind === "condition")).toHaveLength(
      40,
    );
    expect(sample.noted).toHaveLength(1);
  });
});
