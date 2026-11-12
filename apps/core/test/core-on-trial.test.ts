import { defineApp } from "@meetsanctum/app-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  updatePendingFile,
  watchUpdatePending,
} from "../src/update-pending.js";
import { base, running, supervised, useCleanUps } from "./app-apart-support.js";
import { lampsCore, radio, settled } from "./devices-support.js";
import { testCore } from "./support.js";
import {
  addWorkflow,
  sample,
  samplePackage,
  noteStep,
  runsOf,
  steps,
  trigger,
} from "./workflows-support.js";

// A core whose update hasn't committed. A rollback puts its data back, but it
// can't undo what a workflow did to the home or what an app did to data of its
// own, so neither happens until the commit.

useCleanUps();
beforeEach(() => sample.reset());

const job = {
  key: "tidy",
  action: "sample.finish",
  input: { task: "Tidy", room: "Office" },
  when: { at: "2026-10-26T13:00:00Z" },
};

describe("workflows and jobs, on trial", () => {
  it("fires nothing for what happens, which is lost, and fires again after", async () => {
    const { core, maya, lamp } = await lampsCore({ apps: [samplePackage] });
    const { id } = await addWorkflow(core, maya.token, {
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

    core.workflows.hold();
    await radio.press("lamp-1", { on: true });
    await settled();
    await core.workflows.settled();
    expect(await runsOf(core, maya.token, id)).toEqual([]);

    core.workflows.start({ ticking: false });
    await settled();
    await core.workflows.settled();
    // What happened on trial doesn't come back.
    expect(await runsOf(core, maya.token, id)).toEqual([]);

    await radio.press("lamp-1", { on: false });
    await radio.press("lamp-1", { on: true });
    await settled();
    await core.workflows.settled();

    expect(await runsOf(core, maya.token, id)).toHaveLength(1);
  });

  it("leaves a job that fell due waiting, and runs it after the commit", async () => {
    const before = await testCore({ apps: [samplePackage] });
    before.workflows.jobs.schedule(samplePackage.app.id, job);

    const core = await testCore({
      apps: [samplePackage],
      dataDir: before.dataDir,
      startsAt: "2026-10-26T13:00:00Z",
      onTrial: true,
    });
    await core.workflows.settled();
    // A one-off job goes once it has run.
    expect(core.workflows.jobs.list(samplePackage.app.id)).toHaveLength(1);

    await core.apps.committed();
    await running(core, samplePackage.app.id);
    core.workflows.start({ ticking: false });
    core.workflows.tick();
    await core.workflows.settled();

    expect(core.workflows.jobs.list(samplePackage.app.id)).toEqual([]);
  });
});

describe("an app that runs apart, on trial", () => {
  const app = (started: string[]) =>
    defineApp({
      ...base,
      id: "test.apart",
      permissions: [],
      actions: [],
      start: async () => void started.push("start"),
    });

  it("gets no container until the commit, and then starts as usual", async () => {
    const started: string[] = [];
    const { core, containers, running, stateOf } = await supervised(
      app(started),
      { onTrial: true },
    );
    await new Promise((done) => setTimeout(done, 50));

    expect(containers()).toBe(0);
    expect(started).toEqual([]);
    expect(stateOf().state).toBe("starting");
    expect(core.apps.isRunning("test.apart")).toBe(false);

    await core.apps.committed();
    await running();

    expect(containers()).toBe(1);
    expect(started).toEqual(["start"]);
    expect(stateOf().run?.failures).toBeUndefined();
  });

  it("hears the commit only with every app installed, and no start waited for", async () => {
    const ids = ["test.one", "test.two", "test.three"];
    const packages = ids.map((id) => ({
      app: defineApp({ ...base, id, permissions: [], actions: [] }),
      origin: "official" as const,
    }));
    let finish!: () => void;
    const slow = {
      app: defineApp({
        ...base,
        id: "test.slow",
        permissions: [],
        actions: [],
        start: () =>
          new Promise<void>((done) => {
            finish = done;
          }),
      }),
      origin: "official" as const,
    };
    const core = await testCore();

    const starting = core.startApps([...packages, slow]);
    await core.apps.committed();

    expect(core.apps.list().map(({ id }) => id)).toEqual(
      expect.arrayContaining([...ids, "test.slow"]),
    );
    // It got here with that start still under way, which only this ends.
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish();
    await starting;
  });

  it("starts only once if the commit is heard twice", async () => {
    const { core, containers, running } = await supervised(app([]), {
      onTrial: true,
    });

    await core.apps.committed();
    await core.apps.committed();
    await running();

    expect(containers()).toBe(1);
  });

  it("runs as usual on a core with no update to wait for", async () => {
    const { containers, running } = await supervised(app([]));

    await running();

    expect(containers()).toBe(1);
  });
});

describe("hearing the commit", () => {
  const folder = async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sanctum-core-"));
    return dataDir;
  };

  it("runs at once when nothing is pending", async () => {
    const pending = watchUpdatePending(await folder());
    const run = vi.fn();

    pending.whenCommitted(run);

    expect(run).toHaveBeenCalledOnce();
    pending.close();
  });

  it("waits for the manager to remove the marker, then runs once", async () => {
    const dataDir = await folder();
    await writeFile(join(dataDir, updatePendingFile), "update-1");
    const pending = watchUpdatePending(dataDir, 5);
    const run = vi.fn();

    pending.whenCommitted(run);
    await new Promise((done) => setTimeout(done, 30));
    expect(run).not.toHaveBeenCalled();

    await rm(join(dataDir, updatePendingFile));
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await new Promise((done) => setTimeout(done, 30));

    expect(run).toHaveBeenCalledOnce();
    pending.close();
  });

  it("runs nothing for a core that stops first, as in a rollback", async () => {
    const dataDir = await folder();
    await writeFile(join(dataDir, updatePendingFile), "update-1");
    const pending = watchUpdatePending(dataDir, 5);
    const run = vi.fn();

    pending.whenCommitted(run);
    pending.close();
    await rm(join(dataDir, updatePendingFile));
    await new Promise((done) => setTimeout(done, 30));

    expect(run).not.toHaveBeenCalled();
  });
});
