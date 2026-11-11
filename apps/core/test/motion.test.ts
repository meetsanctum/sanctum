import type { WorkflowNode } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { command, lampsCore, radio, settled } from "./devices-support.js";
import { get, post, type TestCore } from "./support.js";
import {
  addWorkflow,
  runByHand,
  runsOf,
  trigger,
} from "./workflows-support.js";

// Motion sensors: motion is a kind of its own, `occupancy`, with the sensor's
// settings, beside its light level and temperature as `sensor` readings. The
// core keeps when a capability's state last changed, and its motion and
// light-level pieces read a place's sensors together.

const minute = 60_000;

async function deviceOf(core: TestCore, token: string, id: string) {
  const devices = (await get(core, "/api/devices", { token })).json();
  return devices.find((each: { id: string }) => each.id === id);
}

// A home with an office and a hall, and two motion sensors and the lamp in
// the office.
async function home() {
  const context = await lampsCore();
  const { core, maya } = context;
  const token = maya.token;
  const room = async (name: string) =>
    (await post(core, "/api/places/rooms/add", { name }, { token })).json()
      .id as string;
  const office = await room("Office");
  const hall = await room("Hall");
  await radio.add("motion-1", "occupancy", "Desk motion");
  await radio.add("motion-2", "occupancy", "Door motion");
  await settled();
  const devices = (await get(core, "/api/devices", { token })).json() as {
    id: string;
    driverName: string;
  }[];
  const idOf = (name: string) =>
    devices.find((device) => device.driverName === name)!.id;
  const ids = {
    desk: idOf("Desk motion"),
    door: idOf("Door motion"),
    lamp: context.lamp,
  };
  for (const id of Object.values(ids)) {
    await post(core, "/api/devices/update", { id, roomId: office }, { token });
  }
  return { ...context, token, office, hall, ids };
}

const sees = async (key: string, occupied: boolean) => {
  await radio.press(key, { occupied });
  await settled();
};

async function tick(core: TestCore) {
  core.workflows.tick();
  await core.workflows.settled();
}

const lightsOn = (place: object): WorkflowNode => ({
  id: "on",
  kind: "step",
  piece: "lights",
  config: { place, to: "on" },
});

describe("a motion sensor", () => {
  it("comes in with its motion and settings, its light level and its temperature", async () => {
    const { core, token, ids } = await home();

    expect(await deviceOf(core, token, ids.desk)).toMatchObject({
      name: "Office motion sensor",
      battery: 90,
      capabilities: [
        {
          id: "occupancy",
          kind: "occupancy",
          features: {
            senses: "motion",
            sensitivity: ["low", "medium", "high"],
            clearAfter: { min: 10, max: 3600 },
            indicator: true,
          },
          state: {
            occupied: false,
            sensitivity: "medium",
            clearAfter: 60,
            indicator: true,
          },
          changedAt: core.now().toISOString(),
        },
        {
          id: "illuminance",
          kind: "sensor",
          features: { measures: "illuminance" },
          state: { value: 320 },
        },
        {
          id: "temperature",
          kind: "sensor",
          features: { measures: "temperature" },
          state: { value: 21 },
        },
      ],
    });
  });

  it("keeps when its motion last changed, which a change of setting leaves", async () => {
    const { core, token, ids } = await home();
    core.advance(minute);
    await sees("motion-1", true);
    const seenAt = core.now().toISOString();
    core.advance(minute);
    await sees("motion-1", true);
    expect(
      (
        await command(core, token, ids.desk, "occupancy", {
          sensitivity: "high",
        })
      ).statusCode,
    ).toBe(200);
    await settled();

    const [occupancy] = (await deviceOf(core, token, ids.desk)).capabilities;
    expect(occupancy).toMatchObject({
      state: { occupied: true, sensitivity: "high" },
      sync: "synced",
      changedAt: seenAt,
    });
    expect(radio.received.at(-1)!.command).toMatchObject({
      kind: "occupancy",
      command: { sensitivity: "high" },
    });
  });

  it("refuses a setting it does not have", async () => {
    const { core, token, ids } = await home();
    for (const body of [
      { sensitivity: "max" },
      { clearAfter: 5 },
      { occupied: true },
    ]) {
      expect(
        (await command(core, token, ids.desk, "occupancy", body)).statusCode,
      ).toBe(400);
    }
    expect(radio.received).toEqual([]);
  });
});

describe("Motion in a place", () => {
  it("starts a run once as the place goes from no motion to motion, however many sensors see it", async () => {
    const { core, token, office } = await home();
    const place = { kind: "room", id: office };
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [trigger("motion", "motion", { place }), lightsOn(place)],
        edges: [{ from: "motion", to: "on" }],
      },
    });

    await sees("motion-1", true);
    await sees("motion-2", true);
    await sees("motion-1", false);
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(1);

    await sees("motion-2", false);
    await sees("motion-2", true);
    await core.workflows.settled();
    const runs = await runsOf(core, token, id);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.status).toBe("succeeded");
  });

  it("names its place in the run's activity entry, and how long a quiet one waited", async () => {
    const { core, token, office } = await home();
    const place = { kind: "room", id: office };
    await addWorkflow(core, token, {
      name: "Office lights with motion",
      graph: {
        version: 1,
        nodes: [trigger("motion", "motion", { place }), lightsOn(place)],
        edges: [{ from: "motion", to: "on" }],
      },
    });
    await addWorkflow(core, token, {
      name: "Office lights off",
      graph: {
        version: 1,
        nodes: [
          trigger("quiet", "noMotion", { place, forMinutes: 10 }),
          lightsOn(place),
        ],
        edges: [{ from: "quiet", to: "on" }],
      },
    });
    await sees("motion-1", true);
    await sees("motion-1", false);
    core.advance(10 * minute);
    await tick(core);

    const page = (await get(core, "/api/activity", { token })).json() as {
      entries: { action: string; detail: { trigger?: unknown } }[];
    };
    expect(
      page.entries
        .filter((entry) => entry.action === "workflow.run")
        .map((entry) => entry.detail.trigger),
    ).toEqual([
      { piece: "noMotion", app: null, place: "Office", forMinutes: 10 },
      { piece: "motion", app: null, place: "Office" },
    ]);
  });

  it("leaves out a sensor that is offline", async () => {
    const { core, token, office } = await home();
    const place = { kind: "room", id: office };
    await sees("motion-2", true);
    await radio.unplug("motion-2");
    await settled();
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [trigger("motion", "motion", { place }), lightsOn(place)],
        edges: [{ from: "motion", to: "on" }],
      },
    });

    await sees("motion-1", true);
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(1);
  });
});

describe("No motion in a place for a while", () => {
  async function quietWorkflow() {
    const context = await home();
    const { core, token, office } = context;
    const place = { kind: "room", id: office };
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("quiet", "noMotion", { place, forMinutes: 10 }),
          {
            id: "off",
            kind: "step",
            piece: "lights",
            config: { place, to: "off" },
          },
        ],
        edges: [{ from: "quiet", to: "off" }],
      },
    });
    return { ...context, id };
  }

  it("starts a run once every sensor there has been quiet that long, once per quiet spell", async () => {
    const { core, token, id } = await quietWorkflow();
    await sees("motion-1", true);
    await sees("motion-2", true);
    await sees("motion-1", false);
    core.advance(15 * minute);
    await tick(core);
    // The door's sensor still sees someone.
    expect(await runsOf(core, token, id)).toHaveLength(0);

    await sees("motion-2", false);
    core.advance(9 * minute);
    await tick(core);
    expect(await runsOf(core, token, id)).toHaveLength(0);
    core.advance(minute);
    await tick(core);
    expect(await runsOf(core, token, id)).toHaveLength(1);
    core.advance(30 * minute);
    await tick(core);
    expect(await runsOf(core, token, id)).toHaveLength(1);

    // Motion again starts another quiet spell.
    await sees("motion-1", true);
    await sees("motion-1", false);
    core.advance(10 * minute);
    await tick(core);
    expect(await runsOf(core, token, id)).toHaveLength(2);
  });

  it("waits again when there is motion before it is due", async () => {
    const { core, token, id } = await quietWorkflow();
    await sees("motion-1", true);
    await sees("motion-1", false);
    core.advance(8 * minute);
    await sees("motion-1", true);
    core.advance(2 * minute);
    await sees("motion-1", false);
    core.advance(9 * minute);
    await tick(core);
    expect(await runsOf(core, token, id)).toHaveLength(0);
    core.advance(minute);
    await tick(core);
    expect(await runsOf(core, token, id)).toHaveLength(1);
  });

  it("keeps a due timer when a sensor reports again before the next tick", async () => {
    const { core, token, id } = await quietWorkflow();
    await sees("motion-1", true);
    await sees("motion-1", false);
    core.advance(10 * minute);
    await sees("motion-1", false);
    await tick(core);
    expect(await runsOf(core, token, id)).toHaveLength(1);

    await sees("motion-2", false);
    await tick(core);
    expect(await runsOf(core, token, id)).toHaveLength(1);
  });

  it("never fires for a place with no sensor answering", async () => {
    const { core, token, id } = await quietWorkflow();
    await radio.unplug("motion-1");
    await radio.unplug("motion-2");
    await settled();
    core.advance(60 * minute);
    await tick(core);
    expect(await runsOf(core, token, id)).toHaveLength(0);
  });
});

describe("the motion and light-level conditions", () => {
  // A workflow run by hand that reaches its step only if `condition` passes.
  async function passes(core: TestCore, token: string, condition: object) {
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("hand", "manual"),
          { id: "if", kind: "condition", ...condition },
          lightsOn({ kind: "home" }),
        ],
        edges: [
          { from: "hand", to: "if" },
          { from: "if", to: "on" },
        ],
      },
    });
    await runByHand(core, token, id);
    await core.workflows.settled();
    const [run] = await runsOf(core, token, id);
    return run!.status === "succeeded";
  }

  it("ask whether a place has motion, or has had none for a while", async () => {
    const { core, token, office, hall } = await home();
    const place = { kind: "room", id: office };
    const motion = { piece: "motion", config: { place } };
    const quiet = { piece: "noMotion", config: { place, forMinutes: 10 } };

    await sees("motion-1", true);
    expect(await passes(core, token, motion)).toBe(true);
    expect(await passes(core, token, quiet)).toBe(false);

    await sees("motion-1", false);
    core.advance(9 * minute);
    expect(await passes(core, token, motion)).toBe(false);
    expect(await passes(core, token, quiet)).toBe(false);
    core.advance(minute);
    expect(await passes(core, token, quiet)).toBe(true);

    // The hall has no motion sensor, so it is neither.
    const hallPlace = { kind: "room", id: hall };
    expect(
      await passes(core, token, {
        piece: "motion",
        config: { place: hallPlace },
      }),
    ).toBe(false);
    expect(
      await passes(core, token, {
        piece: "noMotion",
        config: { place: hallPlace, forMinutes: 1 },
      }),
    ).toBe(false);
  });

  it("read a place's light level from its brightest sensor that answers", async () => {
    const { core, token, office } = await home();
    const place = { kind: "room", id: office };
    const level = (is: string, lux: number) => ({
      piece: "lightLevel",
      config: { place, is, lux },
    });
    await radio.press("motion-1", { illuminance: 320 });
    await radio.press("motion-2", { illuminance: 12 });
    await settled();

    expect(await passes(core, token, level("darker", 400))).toBe(true);
    expect(await passes(core, token, level("darker", 100))).toBe(false);
    expect(await passes(core, token, level("brighter", 100))).toBe(true);

    await radio.unplug("motion-1");
    expect(await passes(core, token, level("darker", 100))).toBe(true);
    await radio.unplug("motion-2");
    expect(await passes(core, token, level("darker", 100))).toBe(false);
    expect(await passes(core, token, level("brighter", 0))).toBe(false);
  });
});

describe("a device trigger with below or above", () => {
  it("fires as a reading crosses its number, not on every reading past it", async () => {
    const { core, token, ids } = await home();
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("dark", "device", {
            device: ids.desk,
            capability: "illuminance",
            field: "value",
            operator: "below",
            value: 30,
          }),
          lightsOn({ kind: "home" }),
        ],
        edges: [{ from: "dark", to: "on" }],
      },
    });

    for (const illuminance of [200, 25, 20, 12, 40, 28]) {
      await radio.press("motion-1", { illuminance });
      await settled();
    }
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(2);
  });
});
