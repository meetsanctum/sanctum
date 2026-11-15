import { beforeEach, describe, expect, it } from "vitest";

import { claimed, testCore } from "./support.js";
import {
  addWorkflow,
  noteStep,
  runByHand,
  runsOf,
  sample,
  samplePackage,
  steps,
  trigger,
} from "./workflows-support.js";

// Workflows as the core stops (lifecycle.ts): from stopping's first moment no
// run starts, from a press, the queue or a timer, and each run under way ends
// as interrupted before its next step, as after a crash.

beforeEach(() => sample.reset());

async function home() {
  const core = await testCore({ apps: [samplePackage] });
  const { token } = await claimed(core);
  return { core, token };
}

describe("workflows as the core stops", () => {
  it("end a run under way as interrupted before its next step", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      graph: steps(trigger("t", "manual"), noteStep("first"), noteStep("last")),
    });
    const release = sample.holdSteps();
    const run = (await runByHand(core, token, id)).json();

    core.workflows.interrupt();
    release();
    await core.workflows.settled();

    expect(core.workflows.run(run.id)).toMatchObject({
      status: "failed",
      reason: "interrupted",
    });
    expect(sample.noted.map(({ text }) => text)).toEqual(["first"]);
  });

  it("start no run from the queue, and end those waiting there as interrupted", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      runMode: "queued",
      graph: steps(trigger("t", "manual"), noteStep("note")),
    });
    const release = sample.holdSteps();
    await runByHand(core, token, id);
    const queued = (await runByHand(core, token, id)).json();
    expect(core.workflows.run(queued.id)?.status).toBe("queued");

    core.workflows.interrupt();

    expect(core.workflows.run(queued.id)).toMatchObject({
      status: "failed",
      reason: "interrupted",
    });
    release();
    await core.workflows.settled();
    expect(sample.noted).toHaveLength(1);
  });

  it("start no run by hand", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      graph: steps(trigger("t", "manual"), noteStep("note")),
    });

    core.workflows.interrupt();
    const refused = await runByHand(core, token, id);

    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({ error: "stopping" });
    expect(await runsOf(core, token, id)).toEqual([]);
  });

  it("start no run for a time that comes", async () => {
    const { core, token } = await home();
    const { id } = await addWorkflow(core, token, {
      graph: steps(trigger("t", "time", { time: "13:00" }), noteStep("note")),
    });

    core.workflows.interrupt();
    core.advance(60 * 60_000);
    core.workflows.tick();
    await core.workflows.settled();

    expect(await runsOf(core, token, id)).toEqual([]);
    expect(sample.noted).toEqual([]);
  });
});
