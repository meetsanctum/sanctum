import {
  ActionError,
  type DeviceInfo,
  type LightState,
  type TurnOn,
} from "@meetsanctum/app-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMood, deleteMood } from "../../src/moods/actions.js";
import {
  chooseTurnOn,
  listSchedules,
  scheduleMood,
  unscheduleMood,
} from "../../src/schedules/actions.js";
import { applySchedule } from "../../src/schedules/jobs.js";
import { startableHome } from "../moods/core.js";
import { device, lightCapability } from "../moods/home.js";

// A room's schedule, how its lights turn on and the snapshot of them
// (v1's room schedules, target settings and light snapshots, ported from
// room-schedules.test.ts and system-action-runner.test.ts, Pragmata
// v1-final), against Moods' own database and a core that keeps its jobs
// and entities. The home's day runs in UTC, and it is 15:20 on 30 October.

const at = (time: string) => new Date(`2026-10-30T${time}:00.000Z`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("15:20"));
});
afterEach(() => {
  vi.useRealTimers();
});

const lit = (state: LightState | null) => [lightCapability(state)];

function office() {
  return [
    device("desk", "office", lit({ on: true, brightness: 60 })),
    device("ceiling", "office", lit({ on: true, brightness: 90 })),
    device("shelf", "office", lit({ on: false, brightness: 30 })),
    device("counter", "kitchen", lit({ on: true, brightness: 50 })),
  ];
}

const showing = (state: LightState | null) => (device: DeviceInfo) => {
  device.capabilities = lit(state);
};

const focusLights = [
  {
    device: "desk",
    capability: "light",
    state: { on: true as const, brightness: 100 },
  },
  {
    device: "ceiling",
    capability: "light",
    state: { on: true as const, brightness: 80 },
  },
];

async function home() {
  const context = startableHome({ devices: office() });
  await context.start();
  const { call } = context;
  const focus = await call(createMood, {
    roomId: "office",
    name: "Focus",
    icon: "briefcase",
    lights: focusLights,
  });
  const night = await call(createMood, {
    roomId: "office",
    name: "Night",
    icon: "moon",
    lights: [
      {
        device: "desk",
        capability: "light",
        state: { on: true, brightness: 10 },
      },
    ],
  });
  const counter = await call(createMood, {
    roomId: "kitchen",
    name: "Cook",
    lights: [{ device: "counter", capability: "light", state: { on: true } }],
  });
  const turnOn = () =>
    context.state.entities.get("turn-on:office")?.state as TurnOn | undefined;
  const jobs = () =>
    [...context.state.jobs.values()]
      .map((job) => [job.key, job.when])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { ...context, focus, night, counter, turnOn, jobs };
}

describe("a room's schedule", () => {
  it("reschedules its boundaries when the home's time zone changes", async () => {
    const { call, focus, state, hand, turnOn } = await home();
    await call(scheduleMood, {
      roomId: "office",
      moodId: focus.id,
      start: 540,
      end: 1020,
    });
    state.scheduledJobs.length = 0;
    const before = { kind: "home" as const, ...state.places.home };
    state.places.home.timeZone = "America/New_York";
    await hand({
      name: "place.changed",
      before,
      place: { kind: "home", ...state.places.home },
    });
    expect(state.scheduledJobs.map((job) => job.when)).toEqual([
      { daily: "09:00" },
      { daily: "17:00" },
    ]);
    // The same times in another zone, which only a fresh start works out.
    expect(state.scheduledJobs.map((job) => job.fresh)).toEqual([true, true]);
    expect(turnOn()?.until).toBe("2026-10-30T21:00:00.000Z");
  });

  it("schedules the room's own moods, with a daily job at each start and end", async () => {
    const { call, focus, night, jobs } = await home();

    await call(scheduleMood, {
      roomId: "office",
      moodId: focus.id,
      start: 9 * 60,
      end: 17 * 60,
    });
    const schedule = await call(scheduleMood, {
      roomId: "office",
      moodId: night.id,
      start: 22 * 60,
      end: 6 * 60 + 30,
    });

    expect(schedule.scheduled).toMatchObject([
      { moodId: focus.id, start: 540, end: 1020 },
      { moodId: night.id, start: 1320, end: 390 },
    ]);
    expect(jobs()).toEqual([
      ["schedule:office:1020", { daily: "17:00" }],
      ["schedule:office:1320", { daily: "22:00" }],
      ["schedule:office:390", { daily: "06:30" }],
      ["schedule:office:540", { daily: "09:00" }],
    ]);
  });

  // After an update, the core keeps only the jobs the new version's start
  // schedules; one scheduled as it was keeps its next run.
  it("schedules every job again as it starts, those it has too, keeping their times", async () => {
    const { call, focus, state, start } = await home();
    await call(scheduleMood, {
      roomId: "office",
      moodId: focus.id,
      start: 540,
      end: 1020,
    });
    state.scheduledJobs.length = 0;

    await start();

    expect(
      state.scheduledJobs.map(({ key, when, fresh }) => ({ key, when, fresh })),
    ).toEqual([
      {
        key: "schedule:office:540",
        when: { daily: "09:00" },
        fresh: undefined,
      },
      {
        key: "schedule:office:1020",
        when: { daily: "17:00" },
        fresh: undefined,
      },
    ]);
  });

  it("refuses another room's mood, a time that overlaps, and an end at its start", async () => {
    const { call, focus, counter } = await home();
    await call(scheduleMood, {
      roomId: "office",
      moodId: focus.id,
      start: 540,
      end: 1020,
    });

    await expect(
      call(scheduleMood, {
        roomId: "office",
        moodId: counter.id,
        start: 0,
        end: 60,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      call(scheduleMood, {
        roomId: "office",
        moodId: focus.id,
        start: 960,
        end: 1080,
      }),
    ).rejects.toBeInstanceOf(ActionError);
    await expect(
      call(scheduleMood, {
        roomId: "office",
        moodId: focus.id,
        start: 0,
        end: 1440,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(() =>
      scheduleMood.input.parse({
        roomId: "office",
        moodId: focus.id,
        start: 60,
        end: 60,
      }),
    ).toThrow();
    expect(() =>
      scheduleMood.input.parse({
        roomId: "office",
        moodId: focus.id,
        start: 61,
        end: 120,
      }),
    ).toThrow();
  });

  it("moves a scheduled mood, and takes its jobs with it", async () => {
    const { call, focus, jobs } = await home();
    const { scheduled } = await call(scheduleMood, {
      roomId: "office",
      moodId: focus.id,
      start: 540,
      end: 1020,
    });

    await call(scheduleMood, {
      id: scheduled[0]!.id,
      roomId: "office",
      moodId: focus.id,
      start: 600,
      end: 1020,
    });
    expect(jobs().map(([key]) => key)).toEqual([
      "schedule:office:1020",
      "schedule:office:600",
    ]);

    await call(unscheduleMood, { id: scheduled[0]!.id });
    expect(jobs()).toEqual([]);
    expect((await call(listSchedules, { roomId: "office" }))[0]).toEqual({
      roomId: "office",
      scheduled: [],
      turnOn: "followSchedule",
      snapshot: null,
    });
  });

  it("takes a deleted mood off the schedule, and a deleted room's schedule with it", async () => {
    const { call, focus, night, jobs, deleteRoom, state } = await home();
    for (const [mood, start, end] of [
      [focus, 540, 1020],
      [night, 1320, 390],
    ] as const) {
      await call(scheduleMood, {
        roomId: "office",
        moodId: mood.id,
        start,
        end,
      });
    }
    await call(chooseTurnOn, { roomId: "office", turnOn: "asTheyWere" });

    await call(deleteMood, { id: focus.id });
    expect(jobs().map(([key]) => key)).toEqual([
      "schedule:office:1320",
      "schedule:office:390",
    ]);

    await deleteRoom("office");
    expect(jobs()).toEqual([]);
    expect(state.entities.has("turn-on:office")).toBe(false);
  });
});

describe("a schedule's jobs", () => {
  async function scheduled() {
    const context = await home();
    await context.call(scheduleMood, {
      roomId: "office",
      moodId: context.focus.id,
      start: 540,
      end: 1020,
    });
    context.state.commands.length = 0;
    return context;
  }

  it("bring the mood on at its start while a light in the room is on, as v1 did", async () => {
    const { call, state } = await scheduled();

    const result = await call(applySchedule, { roomId: "office", minute: 540 });

    expect(result.ran).toBe("mood");
    expect(
      state.commands.map(({ device, command }) => [device, command]),
    ).toEqual([
      ["ceiling", { on: true, brightness: 80 }],
      ["desk", { on: true, brightness: 100 }],
    ]);
  });

  it("leave a room that is dark as it is", async () => {
    const { call, state, changeDevice } = await scheduled();
    for (const id of ["desk", "ceiling"]) {
      await changeDevice(id, showing({ on: false, brightness: 60 }));
    }
    state.commands.length = 0;

    const result = await call(applySchedule, { roomId: "office", minute: 540 });

    expect(result).toEqual({ ran: "nothing", switched: 0, failed: [] });
    expect(state.commands).toEqual([]);
  });

  it("let go at its end of the lights that still show it, so whatever follows them takes them back", async () => {
    const { call, state, changeDevice } = await scheduled();
    // The desk still shows Focus; someone dimmed the ceiling.
    await changeDevice("desk", showing({ on: true, brightness: 100 }));
    await changeDevice("ceiling", showing({ on: true, brightness: 40 }));
    state.commands.length = 0;

    const result = await call(applySchedule, {
      roomId: "office",
      minute: 1020,
    });

    expect(result.ran).toBe("letGo");
    expect(
      state.commands.map(({ device, command }) => [device, command]),
    ).toEqual([["desk", { on: true }]]);
  });

  it("run the next mood rather than let go where one follows at once", async () => {
    const { call, night, state } = await scheduled();
    await call(scheduleMood, {
      roomId: "office",
      moodId: night.id,
      start: 1020,
      end: 1080,
    });
    state.commands.length = 0;

    const result = await call(applySchedule, {
      roomId: "office",
      minute: 1020,
    });

    // Night sets the desk, and turns the ceiling off.
    expect(result.ran).toBe("mood");
    expect(state.commands.map(({ device }) => device)).toEqual([
      "desk",
      "ceiling",
    ]);
  });
});

describe("turning a room on", () => {
  it("republishes its saved rule on start if the core no longer has it", async () => {
    const context = await home();
    await context.changeDevice("desk", showing({ on: false }));
    await context.changeDevice("ceiling", showing({ on: false }));
    const saved = context.turnOn();
    expect(saved).toBeDefined();
    context.state.entities.clear();

    await context.start();

    expect(context.turnOn()).toEqual(saved);
  });

  it("brings the scheduled mood while it holds, its other lights off, until its end", async () => {
    const { call, focus, turnOn } = await home();

    await call(scheduleMood, {
      roomId: "office",
      moodId: focus.id,
      start: 540,
      end: 1020,
    });

    expect(turnOn()).toEqual({
      placeId: "office",
      lights: [
        { device: "desk", capability: "light", state: focusLights[0]!.state },
        {
          device: "ceiling",
          capability: "light",
          state: focusLights[1]!.state,
        },
        { device: "shelf", capability: "light", state: { on: false } },
      ],
      until: "2026-10-30T17:00:00.000Z",
    });
  });

  it("holds an overnight mood until its end the next morning", async () => {
    const { call, night, turnOn } = await home();
    vi.setSystemTime(at("23:30"));

    await call(scheduleMood, {
      roomId: "office",
      moodId: night.id,
      start: 22 * 60,
      end: 6 * 60 + 30,
    });

    expect(turnOn()?.until).toBe("2026-10-31T06:30:00.000Z");
  });

  it("refreshes the rule when a device gains a light capability", async () => {
    const { call, focus, changeDevice, turnOn } = await home();
    await call(scheduleMood, {
      roomId: "office",
      moodId: focus.id,
      start: 540,
      end: 1020,
    });
    await changeDevice("shelf", (device) => {
      device.capabilities.push({
        ...lightCapability({ on: false }),
        id: "second",
      });
    });
    expect(turnOn()?.lights).toContainEqual({
      device: "shelf",
      capability: "second",
      state: { on: false },
    });
  });

  it("brings back the lights that were on when the room went dark, each as it remembers itself", async () => {
    const { changeDevice, turnOn, call } = await home();
    expect(turnOn()).toBeUndefined();

    await changeDevice("desk", showing({ on: false, brightness: 60 }));
    await changeDevice("ceiling", showing({ on: false, brightness: 90 }));

    expect(turnOn()).toEqual({
      placeId: "office",
      lights: [
        { device: "ceiling", capability: "light", state: { on: true } },
        { device: "desk", capability: "light", state: { on: true } },
        { device: "shelf", capability: "light", state: { on: false } },
      ],
      until: null,
    });
    const [schedule] = await call(listSchedules, { roomId: "office" });
    expect(schedule?.snapshot).toEqual({
      takenAt: at("15:20").toISOString(),
      lights: [
        { device: "ceiling", capability: "light" },
        { device: "desk", capability: "light" },
      ],
    });
  });

  it("brings them back exactly as they were where the room chose so, schedule or not", async () => {
    const { call, changeDevice, focus, turnOn } = await home();
    await call(scheduleMood, {
      roomId: "office",
      moodId: focus.id,
      start: 540,
      end: 1020,
    });
    await changeDevice("desk", showing({ on: false, brightness: 60 }));
    await changeDevice("ceiling", showing({ on: false, brightness: 90 }));

    const schedule = await call(chooseTurnOn, {
      roomId: "office",
      turnOn: "asTheyWere",
    });

    expect(schedule.turnOn).toBe("asTheyWere");
    expect(turnOn()).toEqual({
      placeId: "office",
      lights: [
        {
          device: "ceiling",
          capability: "light",
          state: { on: true, brightness: 90 },
        },
        {
          device: "desk",
          capability: "light",
          state: { on: true, brightness: 60 },
        },
        { device: "shelf", capability: "light", state: { on: false } },
      ],
      until: null,
    });
  });

  it("follows the schedule again once its mood ends, by its job", async () => {
    const { call, changeDevice, focus, turnOn } = await home();
    await call(scheduleMood, {
      roomId: "office",
      moodId: focus.id,
      start: 540,
      end: 1020,
    });
    await changeDevice("desk", showing({ on: false, brightness: 60 }));
    await changeDevice("ceiling", showing({ on: false, brightness: 90 }));
    expect(turnOn()?.until).not.toBeNull();

    vi.setSystemTime(at("17:00"));
    await call(applySchedule, { roomId: "office", minute: 1020 });

    expect(turnOn()?.until).toBeNull();
  });
});

describe("a snapshot", () => {
  it("captures the last reported look even when later reports are already in the core", async () => {
    const { state, hand, call, turnOn } = await home();
    const before = structuredClone(
      state.devices.find((device) => device.id === "desk")!,
    );
    const dimmed = {
      ...before,
      capabilities: lit({ on: true, brightness: 12 }),
    };
    const off = { ...before, capabilities: lit({ on: false, brightness: 12 }) };
    const ceiling = structuredClone(
      state.devices.find((device) => device.id === "ceiling")!,
    );
    const ceilingOff = {
      ...ceiling,
      capabilities: lit({ on: false, brightness: 90 }),
    };
    state.devices = state.devices.map((device) =>
      device.id === "desk"
        ? off
        : device.id === "ceiling"
          ? ceilingOff
          : device,
    );
    await hand({ name: "device.changed", before, device: dimmed });
    await hand({ name: "device.changed", before: dimmed, device: off });
    await hand({ name: "device.changed", before: ceiling, device: ceilingOff });
    await call(chooseTurnOn, { roomId: "office", turnOn: "asTheyWere" });
    expect(turnOn()?.lights).toContainEqual({
      device: "desk",
      capability: "light",
      state: { on: true, brightness: 12 },
    });
  });

  it("keeps the lights that went off together with the last one, not one switched off long before", async () => {
    const { changeDevice, turnOn } = await home();
    await changeDevice("desk", showing({ on: false, brightness: 60 }));
    vi.setSystemTime(at("15:40"));

    await changeDevice("ceiling", showing({ on: false, brightness: 90 }));

    expect(turnOn()?.lights).toEqual([
      { device: "ceiling", capability: "light", state: { on: true } },
      { device: "desk", capability: "light", state: { on: false } },
      { device: "shelf", capability: "light", state: { on: false } },
    ]);
  });

  it("is not taken when the last light goes offline rather than off", async () => {
    const { changeDevice, turnOn } = await home();
    await changeDevice("desk", showing({ on: false }));
    await changeDevice("ceiling", (device) => {
      device.availability = "offline";
    });

    expect(turnOn()).toBeUndefined();
  });

  it("follows the lights from Moods' start, so one on then counts", async () => {
    const context = startableHome({ devices: office() });
    await context.start();

    await context.changeDevice("desk", showing({ on: false }));
    await context.changeDevice("ceiling", showing({ on: false }));

    expect(
      (context.state.entities.get("turn-on:office")?.state as TurnOn).lights,
    ).toContainEqual({
      device: "desk",
      capability: "light",
      state: { on: true },
    });
  });
});
