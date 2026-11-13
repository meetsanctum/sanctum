import type { ActivityInfo, ActivityPage } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { createActivity } from "../src/activity/activity.js";
import { activityTimes } from "../src/activity/kinds.js";
import { createManagerAuditCopy } from "../src/activity/manager-audit.js";
import { createDeviceLog } from "../src/devices/activity.js";
import { openCoreDatabase } from "../src/database.js";
import {
  command,
  lampsCore,
  openLive,
  personWithClient,
  radio,
  settled,
} from "./devices-support.js";
import { get, post, sharedClient, type TestCore } from "./support.js";
import {
  addWorkflow,
  samplePackage,
  noteStep,
  runByHand,
  steps,
  trigger,
} from "./workflows-support.js";

// The activity log: what happened, who did it and how it ended, for every
// client, with who found at the start of what caused it, commands that leave a
// light on or off joined, and what is past keeping taken out.

async function activityOf(
  core: TestCore,
  token: string,
  query: Record<string, string> = {},
): Promise<ActivityPage> {
  const response = await get(
    core,
    `/api/activity?${new URLSearchParams(query)}`,
    { token },
  );
  expect(response.statusCode).toBe(200);
  return response.json();
}

const ofAction = (page: ActivityPage, action: string) =>
  page.entries.filter((entry) => entry.action === action);

const minute = 60_000;

// How long a test waits for what a 20 ms confirmation deadline leads to: far
// longer than it takes, and short of the test's own time.
const realClock = { timeout: 3_000 };

describe("a device's activity", () => {
  it("says what each command asked for and who sent it", async () => {
    const { core, maya, lamp } = await lampsCore();
    await command(core, maya.token, lamp, "light", {
      on: true,
      brightness: 40,
    });
    await settled();

    const [entry] = ofAction(
      await activityOf(core, maya.token, { device: lamp }),
      "device.command",
    );
    expect(entry).toMatchObject({
      kind: "devices",
      outcome: "ok",
      count: 1,
      detail: { capability: "light", asked: { on: true, brightness: 40 } },
      who: { kind: "person", id: maya.person.id, name: maya.person.name },
      subject: { type: "device", id: lamp, gone: false },
      app: null,
      run: null,
    });
  });

  it("names a shared client as it was named then", async () => {
    const { core, maya, lamp } = await lampsCore();
    const tablet = sharedClient(core);
    await command(core, tablet.token, lamp, "light", { on: true });
    await post(
      core,
      "/api/auth/clients/rename",
      { id: tablet.id, name: "Old tablet" },
      maya,
    );

    const [entry] = ofAction(
      await activityOf(core, maya.token, { device: lamp }),
      "device.command",
    );
    expect(core.auth.clients.name(tablet.id)).toBe("Old tablet");
    expect(entry!.who).toEqual({
      kind: "client",
      id: tablet.id,
      name: "Kitchen tablet",
    });
  });

  it("joins commands that leave a light on or off as it was, and only those", async () => {
    const { core, maya, lamp } = await lampsCore();
    await command(core, maya.token, lamp, "light", {
      on: true,
      brightness: 30,
    });
    await settled();
    for (const brightness of [40, 50, 55]) {
      core.advance(5 * minute);
      await command(core, maya.token, lamp, "light", { brightness });
      await settled();
    }
    // Long after, a new entry; turning it off never joins.
    core.advance(31 * minute);
    await command(core, maya.token, lamp, "light", { brightness: 60 });
    await settled();
    await command(core, maya.token, lamp, "light", { on: false });
    await settled();

    const commands = ofAction(
      await activityOf(core, maya.token, { device: lamp }),
      "device.command",
    );
    expect(
      commands.map(({ count, detail }) => ({ count, asked: detail?.asked })),
    ).toEqual([
      { count: 1, asked: { on: false } },
      { count: 1, asked: { brightness: 60 } },
      { count: 3, asked: { brightness: 55 } },
      { count: 1, asked: { on: true, brightness: 30 } },
    ]);
    const joined = commands[2]!;
    expect(joined.detail?.from).toEqual({ brightness: 40 });
    expect(Date.parse(joined.at) - Date.parse(joined.firstAt!)).toBe(
      10 * minute,
    );
  });

  it("marks a command the device did not answer, even sent again, as failed", async () => {
    const { core, maya, lamp } = await lampsCore({ confirmMs: 20 });
    radio.confirms = false;
    await command(core, maya.token, lamp, "light", { on: true });

    // Both deadlines and the send between them run on the real clock, and
    // the entry says it went again before it says it failed: the test waits
    // for the outcome, however long a slow runner takes.
    const entries = async () =>
      ofAction(
        await activityOf(core, maya.token, { device: lamp }),
        "device.command",
      );
    await expect.poll(entries, realClock).toEqual([
      expect.objectContaining({
        outcome: "failed",
        reason: "no_answer",
        detail: { capability: "light", asked: { on: true }, resent: true },
      }),
    ]);
    expect(radio.received).toHaveLength(2);
  });

  it("says a command went again when the device answered only then", async () => {
    const { core, maya, lamp } = await lampsCore({ confirmMs: 20 });
    radio.confirms = false;
    await command(core, maya.token, lamp, "light", { on: true });
    radio.confirms = true;

    // The deadline and the send after it run on the real clock: the lamp's
    // answer to the second ends the wait, and the log has all of it by then.
    await expect
      .poll(() => core.devices.get(lamp)!.capabilities[0], realClock)
      .toMatchObject({ sync: "synced", state: { on: true } });

    const page = await activityOf(core, maya.token, { device: lamp });
    expect(ofAction(page, "device.command")).toEqual([
      expect.objectContaining({
        outcome: "ok",
        detail: { capability: "light", asked: { on: true }, resent: true },
      }),
    ]);
    // Its answer to the second is not a change outside Sanctum.
    expect(ofAction(page, "device.changed")).toEqual([]);
  });

  it("says when a light was switched outside Sanctum, and not when a command explains it", async () => {
    const { core, maya, lamp } = await lampsCore();
    await command(core, maya.token, lamp, "light", { on: true });
    await settled();
    core.advance(minute);
    await radio.press("lamp-1", { on: false });
    // A brightness change at the device is not news.
    await radio.press("lamp-1", { brightness: 20 });

    const page = await activityOf(core, maya.token, { device: lamp });
    expect(ofAction(page, "device.changed")).toEqual([
      expect.objectContaining({
        detail: { capability: "light", on: false },
        who: { kind: "device" },
      }),
    ]);
  });

  it("says when a device went offline and came back", async () => {
    const { core, maya, lamp } = await lampsCore();
    await radio.unplug("lamp-1");
    radio.gadgets.get("lamp-1")!.answers = true;
    await core.devices.report("test.lamps", {
      key: "lamp-1",
      availability: "online",
    });

    const page = await activityOf(core, maya.token, { device: lamp });
    expect(page.entries.map((entry) => entry.action).slice(0, 2)).toEqual([
      "device.online",
      "device.offline",
    ]);
  });

  it("says when a battery fell low and when it was new, once its first reports have settled", async () => {
    const { core, maya, lamp } = await lampsCore();
    const report = (battery: number) =>
      core.devices.report("test.lamps", { key: "lamp-1", battery });
    // A device's first reports can be wrong, as a dimmer's 5% then 100%.
    await report(5);
    await report(100);
    core.advance(2 * 60 * minute);
    await report(40);
    await report(9);
    await report(8);
    await report(100);

    const page = await activityOf(core, maya.token, { device: lamp });
    const battery = page.entries.filter((entry) =>
      entry.action.startsWith("device.battery."),
    );
    expect(
      battery.map((entry) => [entry.action, entry.kind, entry.detail]),
    ).toEqual([
      ["device.battery.new", "devices", { battery: 100, was: 8 }],
      ["device.battery.low", "devices", { battery: 9, was: 40 }],
    ]);
  });

  it("says when a device on a battery went quiet, with the charge it last said", async () => {
    const { core, maya, lamp, plug } = await lampsCore();
    await core.devices.report("test.lamps", {
      key: "lamp-1",
      availability: "online",
      battery: 6,
    });
    await core.devices.report("test.lamps", {
      key: "lamp-1",
      availability: "unknown",
    });
    // One on mains whose driver no longer knows says nothing.
    await core.devices.report("test.lamps", {
      key: "plug-1",
      availability: "unknown",
    });

    const page = await activityOf(core, maya.token);
    expect(ofAction(page, "device.quiet")).toEqual([
      expect.objectContaining({
        kind: "devices",
        detail: { battery: 6 },
        subject: expect.objectContaining({ id: lamp }),
      }),
    ]);
    expect(
      ofAction(page, "device.quiet").some(
        (entry) => entry.subject?.id === plug,
      ),
    ).toBe(false);
  });

  it("keeps a removed device's name", async () => {
    const { core, maya, lamp } = await lampsCore();
    const name = core.devices.get(lamp)!.name;
    await command(core, maya.token, lamp, "light", { on: true });
    await post(core, "/api/devices/remove", { id: lamp }, maya);

    const page = await activityOf(core, maya.token, { device: lamp });
    expect(page.entries.map((entry) => entry.subject)).toContainEqual({
      type: "device",
      id: lamp,
      name,
      gone: true,
    });
  });
});

describe("what a press led to", () => {
  async function remoteHome() {
    const home = await lampsCore({ apps: [samplePackage] });
    await radio.add("remote-1", "button", "Office remote");
    const remote = core(home)
      .devices.list()
      .find((device) => device.driverName === "Office remote")!.id;
    return { ...home, remote };
  }
  const core = (home: { core: TestCore }) => home.core;

  it("names the press for the run it started, what the run's steps did and what an app did in it", async () => {
    const home = await remoteHome();
    const { maya, lamp, remote } = home;
    const { id: workflow } = await addWorkflow(home.core, maya.token, {
      name: "Desk focus",
      graph: steps(
        trigger("pressed", "press", { device: remote, action: "single" }),
        {
          id: "lamp",
          kind: "step",
          piece: "device",
          config: { device: lamp, capability: "light", command: { on: true } },
        },
        noteStep("note"),
      ),
    });
    await radio.pressButton("remote-1", "single");
    await home.core.workflows.settled();
    await settled();

    const all = await activityOf(home.core, maya.token);
    const [press] = ofAction(all, "device.press");
    const [run] = ofAction(all, "workflow.run");
    const [lit] = ofAction(all, "device.command");
    const [noted] = ofAction(all, "sample.note");
    const pressedBy = { kind: "press", device: remote, action: "single" };
    expect(press).toMatchObject({
      who: pressedBy,
      detail: { action: "single", captured: false },
      caused: {
        runs: [{ type: "workflow", id: workflow, name: "Desk focus" }],
        apps: [{ id: "test.sample" }],
        devices: [{ type: "device", id: lamp }],
        failed: 0,
      },
    });
    expect(run).toMatchObject({
      kind: "automations",
      causeId: press!.id,
      who: pressedBy,
      detail: { status: "succeeded", trigger: { piece: "press" } },
    });
    for (const entry of [lit, noted]) {
      expect(entry).toMatchObject({
        causeId: run!.id,
        who: pressedBy,
        run: { entry: run!.id, workflow, name: "Desk focus" },
      });
    }
    expect(noted!.kind).toBe("automations");
  });

  it("keeps captured presses separate from presses that can run actions", async () => {
    const { core, maya, remote } = await remoteHome();
    await radio.pressButton("remote-1", "hold");
    core.advance(500);
    const capture = (
      await post(core, "/api/devices/capture/start", { device: remote }, maya)
    ).json();
    await radio.pressButton("remote-1", "hold");
    await post(core, "/api/devices/capture/stop", { id: capture.id }, maya);
    core.advance(500);
    await radio.pressButton("remote-1", "hold");
    const presses = ofAction(
      await activityOf(core, maya.token, { device: remote }),
      "device.press",
    );
    expect(
      presses.map(({ count, detail }) => [count, detail?.captured]),
    ).toEqual([
      [1, false],
      [1, true],
      [1, false],
    ]);
  });

  it("joins a held button's repeats, and says a press held back did nothing", async () => {
    const home = await remoteHome();
    const { maya, remote } = home;
    await radio.pressButton("remote-1", "hold");
    home.core.advance(500);
    await radio.pressButton("remote-1", "hold");
    home.core.advance(5_000);
    const capture = (
      await post(
        home.core,
        "/api/devices/capture/start",
        { device: remote },
        maya,
      )
    ).json();
    await radio.pressButton("remote-1", "single");
    await post(
      home.core,
      "/api/devices/capture/stop",
      { id: capture.id },
      maya,
    );
    await settled();

    const presses = ofAction(
      await activityOf(home.core, maya.token, { device: remote }),
      "device.press",
    );
    expect(
      presses.map(({ count, detail }) => ({
        count,
        action: detail?.action,
        captured: detail?.captured,
      })),
    ).toEqual([
      { count: 1, action: "single", captured: true },
      { count: 2, action: "hold", captured: false },
    ]);
    expect(presses[0]!.caused).toEqual({
      runs: [],
      apps: [],
      devices: [],
      failed: 0,
    });
  });
});

describe("a workflow's run", () => {
  it("keeps the person behind an app event and the workflow it starts", async () => {
    const { core, maya } = await lampsCore({ apps: [samplePackage] });
    await addWorkflow(core, maya.token, {
      graph: steps(
        trigger("done", "sample.done", {}, "test.sample"),
        noteStep("note"),
      ),
    });
    const response = await post(
      core,
      "/api/apps/test.sample/actions/sample.finish",
      {
        task: "tidy",
        room: "office",
      },
      maya,
    );
    expect(response.statusCode).toBe(200);
    await core.workflows.settled();
    const page = await activityOf(core, maya.token);
    const [action] = ofAction(page, "sample.finish");
    const [run] = ofAction(page, "workflow.run");
    const [note] = ofAction(page, "sample.note");
    expect(run).toMatchObject({
      causeId: action!.id,
      who: { kind: "person", id: maya.person.id },
    });
    expect(note).toMatchObject({ who: { kind: "person", id: maya.person.id } });
  });

  it("has an entry once it reaches a step, by whoever pressed Run", async () => {
    const { core, maya } = await lampsCore({ apps: [samplePackage] });
    const ben = personWithClient(core);
    const { id } = await addWorkflow(core, maya.token, {
      name: "Tidy",
      graph: steps(trigger("by-hand", "manual"), noteStep("note")),
    });
    await runByHand(core, ben.token, id);
    await core.workflows.settled();
    await settled();

    const [run] = ofAction(await activityOf(core, maya.token), "workflow.run");
    expect(run).toMatchObject({
      who: { kind: "person", id: ben.person.id, name: "Ben" },
      run: { workflow: id, name: "Tidy", trigger: { piece: "manual" } },
      subject: { type: "workflow", id, name: "Tidy" },
    });
  });
});

describe("reading the log", () => {
  it("pages newest first, by kind", async () => {
    const { core, maya, lamp } = await lampsCore();
    for (const on of [true, false, true]) {
      await command(core, maya.token, lamp, "light", { on });
      await settled();
      core.advance(1_000);
    }
    const first = await activityOf(core, maya.token, {
      kind: "devices",
      limit: "2",
    });
    expect(first.more).toBe(true);
    expect(first.entries.map((entry) => entry.detail?.asked)).toEqual([
      { on: true },
      { on: false },
    ]);
    const next = await activityOf(core, maya.token, {
      kind: "devices",
      limit: "2",
      before: first.entries[1]!.id,
    });
    expect(next.entries.map((entry) => entry.detail?.asked)).toEqual([
      { on: true },
    ]);
    expect(next.more).toBe(false);
    const setup = await activityOf(core, maya.token, { kind: "setup" });
    expect(setup.entries.every((entry) => entry.kind === "setup")).toBe(true);
    expect(ofAction(setup, "host.claim")).toHaveLength(1);
  });

  it("keeps the internal stop marker out of the live log too", async () => {
    const { core, maya } = await lampsCore();
    const live = await openLive(core, maya.token);
    core.activity.stop();
    await settled();
    await settled();
    expect(
      live.messages
        .filter((message) => message.type === "activity")
        .map((message) => (message.entry as ActivityInfo).action),
    ).not.toContain("sanctum.stop");
  });

  it("refuses a kind it does not know", async () => {
    const { core, maya } = await lampsCore();
    const response = await get(core, "/api/activity?kind=weather", maya);
    expect(response.statusCode).toBe(400);
  });

  it("tells live clients of each entry once it has committed, and again when it changes", async () => {
    const { core, maya, lamp } = await lampsCore();
    const live = await openLive(core, maya.token);
    await command(core, maya.token, lamp, "light", {
      on: true,
      brightness: 30,
    });
    await settled();
    await command(core, maya.token, lamp, "light", { brightness: 40 });
    await command(core, maya.token, lamp, "light", { brightness: 50 });
    await settled();
    await settled();

    const heard = live.messages
      .filter((message) => message.type === "activity")
      .map((message) => message.entry as ActivityInfo)
      .filter((entry) => entry.action === "device.command");
    expect(heard.map((entry) => entry.count)).toEqual([1, 1, 2]);
    expect(heard[2]!.id).toBe(heard[1]!.id);
  });
});

describe("keeping the log", () => {
  async function log(options: { atMost?: number; pruneEvery?: number } = {}) {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const database = openCoreDatabase(
      await mkdtemp(join(tmpdir(), "sanctum-activity-")),
    );
    const clock = { now: Date.parse("2026-10-01T12:00:00Z") };
    const activity = createActivity(database.db, {
      now: () => new Date(clock.now),
      ...options,
    });
    return {
      db: database.db,
      activity,
      clock,
      close: database.close,
      // The core starting again on the same database.
      restart: () =>
        createActivity(database.db, { now: () => new Date(clock.now) }),
    };
  }
  const day = 24 * 60 * minute;

  it("keeps adjustments to different controls on one device separate", async () => {
    const { activity, close } = await log();
    try {
      const deviceLog = createDeviceLog({ activity, confirmMs: 100 });
      for (const capability of ["left", "right", "right"]) {
        deviceLog.command({ clientId: "tablet" }, "lamp", "ok", undefined, {
          capability,
          kind: "light",
          asked: { brightness: 50 },
          app: null,
        });
      }
      expect(
        activity
          .recent()
          .map(({ count, detail }) => [count, detail?.capability]),
      ).toEqual([
        [2, "right"],
        [1, "left"],
      ]);
    } finally {
      close();
    }
  });

  it("takes out devices' entries after 30 days and setup's after a year", async () => {
    const { activity, clock, close } = await log();
    const write = (source: string, action: string) =>
      activity.for(source)({ action, outcome: "ok" });
    write("devices", "device.command");
    write("people", "person.add");
    clock.now += 31 * day;
    write("devices", "device.command");
    activity.prune();
    expect(activity.recent().map((entry) => entry.action)).toEqual([
      "device.command",
      "person.add",
    ]);
    clock.now += activityTimes.keptMs.setup;
    activity.prune();
    expect(activity.recent()).toEqual([]);
    close();
  });

  it("keeps the most it may, the oldest devices' entries going first", async () => {
    const { activity, clock, close } = await log({ atMost: 3 });
    const write = (source: string, action: string) => {
      activity.for(source)({ action, outcome: "ok" });
      clock.now += 1_000;
    };
    write("people", "person.add");
    write("devices", "device.command");
    write("devices", "device.press");
    write("people", "person.update");
    write("devices", "device.offline");
    activity.prune();
    expect(activity.recent().map((entry) => entry.action)).toEqual([
      "device.offline",
      "person.update",
      "person.add",
    ]);
    close();
  });

  it("keeps the most it may between the daily prunes too", async () => {
    const { activity, clock, close } = await log({ atMost: 3, pruneEvery: 2 });
    for (let index = 0; index < 6; index++) {
      activity.for("devices")({ action: "device.command", outcome: "ok" });
      clock.now += 1_000;
    }
    expect(activity.recent()).toHaveLength(3);
    close();
  });

  it("ends a run the core stopped during as one that didn't finish", async () => {
    const { activity, restart, close } = await log();
    const run = activity.for("workflows")({
      action: "workflow.run",
      outcome: "ok",
      detail: { run: "r1", status: "running" },
    });
    const ended = activity.for("workflows")({
      action: "workflow.run",
      outcome: "ok",
      detail: { run: "r2", status: "succeeded" },
    });
    const again = restart();
    expect(again.get(run)).toMatchObject({
      outcome: "failed",
      reason: "interrupted",
      detail: { run: "r1", status: "failed" },
    });
    expect(again.get(ended)).toMatchObject({
      outcome: "ok",
      detail: { status: "succeeded" },
    });
    close();
  });

  it("says when Sanctum started, and when it had stopped", async () => {
    const { activity, clock, close } = await log();
    activity.start("1.0.0", { ticking: false });
    clock.now += 10 * minute;
    activity.stop();
    const stoppedAt = new Date(clock.now).toISOString();
    clock.now += 2 * minute;
    activity.start("1.0.1", { ticking: false });
    clock.now += minute;
    // No word that it stopped: a power cut.
    activity.start("1.0.1", { ticking: false });

    const starts = activity
      .page({ limit: 10 })
      .entries.filter((entry) => entry.action === "sanctum.start")
      .map((entry) => entry.detail);
    expect(starts).toEqual([
      { version: "1.0.1", stoppedAt: null, unexpected: true },
      { version: "1.0.1", stoppedAt, unexpected: false },
      { version: "1.0.0", stoppedAt: null, unexpected: false },
    ]);
    expect(
      activity.page({ limit: 10 }).entries.map((entry) => entry.action),
    ).not.toContain("sanctum.stop");
    close();
  });

  it("asks the manager again a minute after it starts, once an update has handed over", async () => {
    const { db, activity, close } = await log();
    vi.useFakeTimers();
    try {
      let asked = 0;
      const copy = createManagerAuditCopy({
        db,
        activity,
        audit: async () => {
          asked++;
          return { audit: "a", entries: [] };
        },
        log: () => undefined,
      });
      copy.start();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(asked).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(asked).toBe(2);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(asked).toBe(3);
      copy.close();
    } finally {
      vi.useRealTimers();
      close();
    }
  });

  it("copies the manager's audit once, and a new audit from its start", async () => {
    const { db, activity, close } = await log();
    const asked: number[] = [];
    let answer = {
      audit: "first",
      entries: [
        {
          n: 1,
          at: "2026-10-01T10:00:00.000Z",
          action: "service.start",
          outcome: "ok" as const,
          detail: { service: "zigbee2mqtt" },
        },
      ],
    };
    const copy = createManagerAuditCopy({
      db,
      activity,
      audit: async (after) => {
        asked.push(after);
        return {
          audit: answer.audit,
          entries: answer.entries.filter((entry) => entry.n > after),
        };
      },
      log: () => undefined,
    });
    await copy.copy();
    await copy.copy();
    answer = {
      audit: "second",
      entries: [{ ...answer.entries[0]!, at: "2026-10-01T11:00:00.000Z" }],
    };
    await copy.copy();

    expect(asked).toEqual([0, 1, 1, 0]);
    expect(
      activity.recent().map(({ id, source, kind, at, actor }) => ({
        id,
        source,
        kind,
        at: at.toISOString(),
        actor,
      })),
    ).toEqual([
      {
        id: "manager:second:1",
        source: "manager",
        kind: "system",
        at: "2026-10-01T11:00:00.000Z",
        actor: "sanctum",
      },
      {
        id: "manager:first:1",
        source: "manager",
        kind: "system",
        at: "2026-10-01T10:00:00.000Z",
        actor: "sanctum",
      },
    ]);
    close();
  });
});
