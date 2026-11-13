import { defineApp, sunType, type SunTimes } from "@meetsanctum/app-sdk";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { loadAppPackage } from "./runner-apps.js";
import type { SunDays } from "../src/workflows/jobs.js";
import { lampsCore, radio, settled } from "./devices-support.js";
import { claimed, get, post, testCore, type TestCore } from "./support.js";
import {
  addWorkflow,
  sample,
  samplePackage,
  noteStep,
  runsOf,
  steps,
  trigger,
} from "./workflows-support.js";

// Timers and jobs: time and sun triggers and apps' jobs, kept in the core's
// database so a restart neither runs one twice nor loses it, and one real path
// end to end: at a time of day, the Moods app runs a mood.

beforeEach(() => sample.reset());

// The test cores' clock starts at 2026-10-26T12:00:00Z, in UTC.
const minutes = (count: number) => count * 60_000;

async function tick(core: TestCore) {
  core.workflows.tick();
  await core.workflows.settled();
}

describe("a time-of-day trigger running a mood", () => {
  it("runs moods.runMood at the time, as the workflow, once a day", async () => {
    const moods = await loadAppPackage(
      fileURLToPath(new URL("../../../catalog/apps/moods", import.meta.url)),
      "official",
    );
    const { core, maya, lamp } = await lampsCore({ apps: [moods] });
    const token = maya.token;
    const office = (
      await post(core, "/api/places/rooms/add", { name: "Office" }, { token })
    ).json();
    await post(
      core,
      "/api/devices/update",
      { id: lamp, roomId: office.id },
      { token },
    );
    const mood = await post(
      core,
      "/api/apps/sanctum.moods/actions/moods.createMood",
      {
        roomId: office.id,
        name: "Evening",
        lights: [
          {
            device: lamp,
            capability: "light",
            state: { on: true, brightness: 30, colorTemperature: 400 },
          },
        ],
      },
      { token },
    );
    expect(mood.statusCode).toBe(200);
    const { id } = await addWorkflow(core, token, {
      name: "Evening light",
      graph: steps(trigger("evening", "time", { time: "18:00" }), {
        id: "mood",
        kind: "step",
        app: "sanctum.moods",
        piece: "moods.runMood",
        config: { id: mood.json().id },
      }),
    });

    core.advance(minutes(5 * 60 + 59));
    await tick(core);
    expect(radio.received).toEqual([]);

    core.advance(minutes(1) + 5_000);
    await tick(core);
    await settled();

    expect(radio.received).toEqual([
      {
        command: expect.objectContaining({
          command: { on: true, brightness: 30, colorTemperature: 400 },
        }),
        actor: { kind: "workflow", id },
      },
    ]);
    const [run] = await runsOf(core, token, id);
    expect(run).toMatchObject({
      status: "succeeded",
      trigger: {
        nodes: ["evening"],
        data: { due: "2026-10-26T18:00:00.000Z" },
      },
    });
    expect(run!.steps).toEqual([
      expect.objectContaining({
        node: "mood",
        status: "succeeded",
        output: expect.objectContaining({ failed: [] }),
      }),
    ]);
    expect(
      core.activity.recent().find((entry) => entry.action === "moods.runMood"),
    ).toMatchObject({
      source: "sanctum.moods",
      outcome: "ok",
      actor: `workflow:${id}`,
      personId: null,
    });

    // The timer moved on: nothing more today, and again tomorrow.
    await tick(core);
    core.advance(minutes(24 * 60));
    await tick(core);
    expect(await runsOf(core, token, id)).toHaveLength(2);
  });
});

describe("time triggers", () => {
  async function at13(options: { enabled?: boolean } = {}) {
    const core = await testCore({ apps: [samplePackage] });
    const { token } = await claimed(core);
    const { id } = await addWorkflow(core, token, {
      enabled: options.enabled,
      graph: steps(trigger("t", "time", { time: "13:00" }), noteStep("note")),
    });
    return { core, token, id };
  }

  it("skip a time missed by more than 15 minutes, and run one missed by less", async () => {
    const { core, token, id } = await at13();

    core.advance(minutes(80));
    await tick(core);
    expect((await runsOf(core, token, id))[0]).toMatchObject({
      status: "skipped",
      reason: "missed",
    });

    core.advance(minutes(24 * 60 - 10));
    await tick(core);
    expect((await runsOf(core, token, id))[0]!.status).toBe("succeeded");
    expect(sample.noted).toHaveLength(1);
  });

  it("run in the home's time zone, which Places keeps", async () => {
    const core = await testCore({ apps: [samplePackage], timeZone: null });
    const { token } = await claimed(core);
    const home = await post(
      core,
      "/api/places/home/update",
      { timeZone: "Europe/Berlin" },
      { token },
    );
    expect(home.statusCode).toBe(200);
    await addWorkflow(core, token, {
      graph: steps(trigger("t", "time", { time: "14:00" }), noteStep("note")),
    });

    // 14:00 in Berlin is 13:00 UTC in winter.
    core.advance(minutes(60) + 5_000);
    await tick(core);
    expect(sample.noted).toHaveLength(1);
  });

  it("move on without running while the workflow is off", async () => {
    const { core, token, id } = await at13({ enabled: false });
    core.advance(minutes(61));
    await tick(core);
    await post(core, "/api/workflows/update", { id, enabled: true }, { token });
    await tick(core);
    expect(await runsOf(core, token, id)).toEqual([]);
  });

  it("are neither run twice nor lost across a restart", async () => {
    const { core, token, id } = await at13();
    core.advance(minutes(60) + 5_000);
    await tick(core);
    expect(await runsOf(core, token, id)).toHaveLength(1);

    // The same data, half a minute later: the 13:00 run has happened.
    const again = await testCore({
      dataDir: core.dataDir,
      apps: [samplePackage],
      startsAt: "2026-10-26T13:00:30Z",
    });
    await tick(again);
    expect(await runsOf(again, token, id)).toHaveLength(1);

    // Down from 12:59 to 13:05 the next day: the run comes 5 minutes late.
    const late = await testCore({
      dataDir: core.dataDir,
      apps: [samplePackage],
      startsAt: "2026-10-27T13:05:00Z",
    });
    await tick(late);
    const runs = await runsOf(late, token, id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      status: "succeeded",
      trigger: { data: { due: "2026-10-27T13:00:00.000Z" } },
    });
  });
});

describe("sun triggers", () => {
  const sunTimes: SunDays = [
    {
      date: "2026-10-26",
      sunrise: "2026-10-26T06:30:00Z",
      sunset: "2026-10-26T16:40:00Z",
    },
    {
      date: "2026-10-27",
      sunrise: "2026-10-27T06:32:00Z",
      sunset: "2026-10-27T16:38:00Z",
    },
  ];

  // A workflow and an app's job at sunset, and a way to move today's sunset,
  // as saving the home's elevation or location does.
  async function atSunset() {
    let sun = sunTimes;
    const core = await testCore({ apps: [samplePackage], sun: () => sun });
    const { token } = await claimed(core);
    const { id } = await addWorkflow(core, token, {
      graph: steps(
        trigger("dusk", "sun", { event: "sunset" }),
        noteStep("note"),
      ),
    });
    const scheduleJob = () =>
      core.workflows.jobs.schedule("test.sample", {
        key: "dusk",
        action: "sample.tick",
        input: {},
        when: { sun: "sunset" },
      });
    scheduleJob();
    const sunsetToday = (time: string) => {
      sun = [
        { ...sunTimes[0]!, sunset: `2026-10-26T${time}:00Z` },
        sunTimes[1]!,
      ];
    };
    return { core, token, id, scheduleJob, sunsetToday };
  }

  it("run at sunset, moved by the offset", async () => {
    const core = await testCore({ apps: [samplePackage], sun: () => sunTimes });
    const { token } = await claimed(core);
    const added = await addWorkflow(core, token, {
      graph: steps(
        trigger("dusk", "sun", { event: "sunset", offsetMinutes: -30 }),
        noteStep("note"),
      ),
    });
    expect(added.warnings).toEqual([]);

    core.advance(minutes(4 * 60 + 9));
    await tick(core);
    expect(sample.noted).toEqual([]);
    core.advance(minutes(1) + 5_000);
    await tick(core);
    expect(sample.noted).toHaveLength(1);
  });

  it("take the sun from the app that provides the sun entity", async () => {
    const day = (date: string, sunset: string) => ({
      date,
      sunrise: `${date}T06:30:00Z`,
      sunset: `${date}T${sunset}:00Z`,
      solarNoon: `${date}T11:35:00Z`,
    });
    const sun: SunTimes = {
      date: "2026-10-26",
      timeZone: "UTC",
      days: [
        day("2026-10-25", "16:42"),
        day("2026-10-26", "16:40"),
        day("2026-10-27", "16:38"),
      ],
    };
    const sky = defineApp({
      id: "test.sky",
      name: "Sky",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [],
      actions: [],
      events: [],
      provides: { entities: [sunType] },
      async start(ctx) {
        await ctx.entities.publish({
          type: sunType.id,
          key: "home",
          name: "Home",
          state: sun,
        });
      },
    });
    const core = await testCore({
      apps: [samplePackage, { app: sky, origin: "official" }],
    });
    const { token } = await claimed(core);
    const added = await addWorkflow(core, token, {
      graph: steps(
        trigger("dusk", "sun", { event: "sunset", offsetMinutes: -30 }),
        noteStep("note"),
      ),
    });
    expect(added.warnings).toEqual([]);

    core.advance(minutes(4 * 60 + 10) + 5_000);
    await tick(core);
    expect(sample.noted).toHaveLength(1);
  });

  it("run once for a day whose sunset moves later after they ran", async () => {
    const { core, sunsetToday } = await atSunset();
    core.advance(minutes(4 * 60 + 40) + 5_000);
    await tick(core);
    expect(sample.noted).toHaveLength(1);
    expect(sample.ticks).toHaveLength(1);

    sunsetToday("16:45");
    await tick(core);
    core.advance(minutes(5));
    await tick(core);
    expect(sample.noted).toHaveLength(1);
    expect(sample.ticks).toHaveLength(1);

    // Tomorrow's sunset at 16:38.
    core.advance(minutes(24 * 60 - 7));
    await tick(core);
    expect(sample.noted).toHaveLength(2);
    expect(sample.ticks).toHaveLength(2);
  });

  it("run, late, for a day whose sunset moves to just before now", async () => {
    const { core, token, id, sunsetToday } = await atSunset();
    core.advance(minutes(4 * 60 + 35));
    await tick(core);
    expect(sample.noted).toEqual([]);

    sunsetToday("16:30");
    await tick(core);
    await tick(core);
    expect(sample.noted).toHaveLength(1);
    expect(sample.ticks).toHaveLength(1);
    expect((await runsOf(core, token, id))[0]).toMatchObject({
      status: "succeeded",
      trigger: { data: { due: "2026-10-26T16:30:00.000Z" } },
    });
  });

  it("skip a day whose sunset moves to more than 15 minutes before now", async () => {
    const { core, token, id, sunsetToday } = await atSunset();
    core.advance(minutes(4 * 60 + 35));
    await tick(core);

    sunsetToday("16:10");
    await tick(core);
    expect((await runsOf(core, token, id))[0]).toMatchObject({
      status: "skipped",
      reason: "missed",
    });
    expect(sample.noted).toEqual([]);
    expect(sample.ticks).toEqual([]);
  });

  it("keep the day they ran for when saved or scheduled again as they were", async () => {
    const { core, token, id, scheduleJob, sunsetToday } = await atSunset();
    core.advance(minutes(4 * 60 + 40) + 5_000);
    await tick(core);

    sunsetToday("16:45");
    await post(core, "/api/workflows/update", { id, name: "Dusk" }, { token });
    scheduleJob();
    core.advance(minutes(5));
    await tick(core);
    expect(sample.noted).toHaveLength(1);
    expect(sample.ticks).toHaveLength(1);
  });

  it("keeps a sun trigger's day when saves add or omit its default offset", async () => {
    const { core, token, id, sunsetToday } = await atSunset();
    core.advance(minutes(4 * 60 + 40) + 5_000);
    await tick(core);

    sunsetToday("16:45");
    const saved = await post(
      core,
      "/api/workflows/update",
      {
        id,
        graph: steps(
          trigger("dusk", "sun", { event: "sunset", offsetMinutes: 0 }),
          noteStep("note"),
        ),
      },
      { token },
    );
    expect(saved.statusCode).toBe(200);
    core.advance(minutes(5));
    await tick(core);
    expect(sample.noted).toHaveLength(1);

    sunsetToday("16:50");
    const savedAgain = await post(
      core,
      "/api/workflows/update",
      {
        id,
        graph: steps(
          trigger("dusk", "sun", { event: "sunset" }),
          noteStep("note"),
        ),
      },
      { token },
    );
    expect(savedAgain.statusCode).toBe(200);
    core.advance(minutes(5));
    await tick(core);
    expect(sample.noted).toHaveLength(1);
  });

  it("resets a sun trigger's timer when its offset changes", async () => {
    const { core, token, id } = await atSunset();
    const saved = await post(
      core,
      "/api/workflows/update",
      {
        id,
        graph: steps(
          trigger("dusk", "sun", { event: "sunset", offsetMinutes: 30 }),
          noteStep("note"),
        ),
      },
      { token },
    );
    expect(saved.statusCode).toBe(200);
    core.advance(minutes(4 * 60 + 40) + 5_000);
    await tick(core);
    expect(sample.noted).toEqual([]);
    core.advance(minutes(30));
    await tick(core);
    expect(sample.noted).toHaveLength(1);
  });

  it("wait while no app knows the sun, and run once one does", async () => {
    let sun: SunDays | null = null;
    const core = await testCore({ apps: [samplePackage], sun: () => sun });
    const { token } = await claimed(core);
    const added = await addWorkflow(core, token, {
      graph: steps(
        trigger("dusk", "sun", { event: "sunset" }),
        noteStep("note"),
      ),
    });
    expect(added.warnings).toEqual([
      "Sunrise and sunset wait for an app that knows the sun, such as Weather",
    ]);

    await tick(core);
    sun = sunTimes;
    await tick(core);
    core.advance(minutes(4 * 60 + 40) + 5_000);
    await tick(core);
    expect(sample.noted).toHaveLength(1);
  });
});

describe("jobs", () => {
  async function plan(core: TestCore, token: string, body: object) {
    return post(core, "/api/apps/test.sample/actions/sample.plan", body, {
      token,
    });
  }

  async function choresCore() {
    const core = await testCore({ apps: [samplePackage] });
    const { token } = await claimed(core);
    return { core, token };
  }

  it("run the app's action as the app, every so often", async () => {
    const { core, token } = await choresCore();
    const planned = await plan(core, token, {
      key: "tick",
      when: { every: 300 },
    });
    expect(planned.json()).toEqual({ nextAt: "2026-10-26T12:05:00.000Z" });

    core.advance(minutes(5) + 1_000);
    await tick(core);
    await tick(core);

    expect(sample.ticks).toEqual([{ kind: "app", id: "test.sample" }]);
    expect(core.workflows.jobs.list("test.sample")).toEqual([
      expect.objectContaining({
        key: "tick",
        action: "sample.tick",
        nextAt: "2026-10-26T12:10:00.000Z",
      }),
    ]);
    expect(
      core.activity.recent().find((entry) => entry.action === "sample.tick"),
    ).toMatchObject({ outcome: "ok", actor: "app:test.sample" });
  });

  it("are replaced by the app's own key", async () => {
    const { core, token } = await choresCore();
    await plan(core, token, { key: "tick", when: { every: 300 } });
    await plan(core, token, { key: "tick", when: { daily: "07:00" } });
    expect(core.workflows.jobs.list("test.sample")).toEqual([
      expect.objectContaining({
        when: { daily: "07:00" },
        nextAt: "2026-10-27T07:00:00.000Z",
      }),
    ]);
  });

  it("run a one-off job however late, then let it go", async () => {
    const { core, token } = await choresCore();
    await plan(core, token, {
      key: "once",
      when: { at: "2026-10-26T11:00:00Z" },
    });
    await tick(core);
    await tick(core);
    expect(sample.ticks).toHaveLength(1);
    expect(core.workflows.jobs.list("test.sample")).toEqual([]);
  });

  it("skip a recurring time missed by more than 15 minutes", async () => {
    const { core, token } = await choresCore();
    await plan(core, token, { key: "tick", when: { every: 300 } });
    core.advance(minutes(20) + 1_000);
    await tick(core);
    expect(sample.ticks).toEqual([]);
    expect(core.workflows.jobs.list("test.sample")[0]!.nextAt).toBe(
      "2026-10-26T12:25:00.000Z",
    );
  });

  it("refuse an action the app may not run on its own", async () => {
    const { core, token } = await choresCore();
    const refused = await plan(core, token, {
      key: "wipe",
      action: "sample.wipe",
      when: { every: 300 },
    });
    expect(refused.json()).toEqual({ error: "app_failed" });
    expect(core.workflows.jobs.list("test.sample")).toEqual([]);
  });

  it("wait while their app is away, and survive a restart", async () => {
    const { core, token } = await choresCore();
    await plan(core, token, { key: "tick", when: { every: 300 } });
    await core.apps.remove("test.sample");
    core.advance(minutes(6));
    await tick(core);
    expect(sample.ticks).toEqual([]);

    const again = await testCore({
      dataDir: core.dataDir,
      apps: [samplePackage],
      startsAt: "2026-10-26T12:06:00Z",
    });
    await tick(again);
    expect(sample.ticks).toHaveLength(1);
    expect((await get(again, "/api/health")).statusCode).toBe(200);
  });
});
