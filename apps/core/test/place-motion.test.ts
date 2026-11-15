import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createMotion } from "../src/devices/motion.js";
import { deviceCapabilities } from "../src/devices/schema.js";
import { lampsCore, radio, settled } from "./devices-support.js";
import { get, post, type TestCore } from "./support.js";
import {
  addWorkflow,
  lightsOff,
  runByHand,
  runsOf,
  steps,
  trigger,
} from "./workflows-support.js";

// A place's motion, kept as it changes (motion.ts): a zone that loses its
// room with motion, by the room's removal, an edit of the zone or a sensor
// moved out, goes quiet from that moment, and its no-motion triggers, their
// timers and the conditions that read it agree.

const minute = 60_000;

// Upstairs is the office and the bedroom, with a motion sensor in each, and
// a hall below.
async function upstairs() {
  const context = await lampsCore();
  const { core, maya } = context;
  const token = maya.token;
  const room = async (name: string) =>
    (await post(core, "/api/places/rooms/add", { name }, { token })).json()
      .id as string;
  const office = await room("Office");
  const bedroom = await room("Bedroom");
  const hall = await room("Hall");
  const zone = (
    await post(
      core,
      "/api/places/zones/add",
      { name: "Upstairs", roomIds: [office, bedroom] },
      { token },
    )
  ).json().id as string;
  await radio.add("motion-1", "motion", "Desk motion");
  await radio.add("motion-2", "motion", "Bed motion");
  await radio.add("motion-3", "motion", "Shelf motion");
  await settled();
  const devices = (await get(core, "/api/devices", { token })).json() as {
    id: string;
    driverName: string;
  }[];
  const idOf = (name: string) =>
    devices.find((device) => device.driverName === name)!.id;
  const ids = {
    desk: idOf("Desk motion"),
    bed: idOf("Bed motion"),
    shelf: idOf("Shelf motion"),
  };
  const move = (id: string, roomId: string) =>
    post(core, "/api/devices/update", { id, roomId }, { token });
  await move(ids.desk, office);
  await move(ids.shelf, office);
  await move(ids.bed, bedroom);
  const workflow = async (piece: string, place: object) =>
    (
      await addWorkflow(core, token, {
        graph: steps(
          trigger(piece, piece, {
            place,
            ...(piece === "noMotion" && { forMinutes: 10 }),
          }),
          lightsOff("off", { kind: "room", id: hall }),
        ),
      })
    ).id;
  return {
    ...context,
    token,
    office,
    bedroom,
    hall,
    zone,
    ids,
    move,
    upstairs: { kind: "zone" as const, id: zone },
    workflow,
  };
}

const sees = async (key: string, motion: boolean) => {
  await radio.press(key, { motion });
  await settled();
};

async function tick(core: TestCore) {
  core.workflows.tick();
  await core.workflows.settled();
}

// Someone at the desk, the bedroom quiet for two hours, and a workflow that
// waits for ten minutes without motion upstairs.
async function someoneAtTheDesk() {
  const home = await upstairs();
  await sees("motion-3", false);
  await sees("motion-2", false);
  home.core.advance(120 * minute);
  await sees("motion-1", true);
  const quiet = await home.workflow("noMotion", home.upstairs);
  return { ...home, quiet };
}

// A workflow's run comes ten minutes from now, not a minute before.
async function firesTenMinutesAfter(core: TestCore, token: string, id: string) {
  core.advance(9 * minute);
  await tick(core);
  expect(await runsOf(core, token, id)).toHaveLength(0);
  core.advance(minute);
  await tick(core);
  expect(await runsOf(core, token, id)).toHaveLength(1);
}

describe("a zone that loses its room with motion", () => {
  it("is quiet from the room's removal, and its no-motion trigger counts from then", async () => {
    const { core, token, office, quiet } = await someoneAtTheDesk();

    await post(core, "/api/places/rooms/remove", { id: office }, { token });
    await settled();

    await firesTenMinutesAfter(core, token, quiet);
  });

  it("is quiet from an edit that leaves the room out", async () => {
    const { core, token, zone, bedroom, quiet } = await someoneAtTheDesk();

    await post(
      core,
      "/api/places/zones/update",
      { id: zone, roomIds: [bedroom] },
      { token },
    );
    await settled();

    await firesTenMinutesAfter(core, token, quiet);
  });

  it("is quiet once its sensors with motion move out, and the room they move to starts nothing", async () => {
    const home = await someoneAtTheDesk();
    const { core, token, ids, hall, move, quiet } = home;
    await sees("motion-3", true);
    const inTheHall = await home.workflow("motion", { kind: "room", id: hall });

    await move(ids.desk, hall);
    await settled();
    // The shelf's sensor still sees someone upstairs.
    core.advance(30 * minute);
    await tick(core);
    expect(await runsOf(core, token, quiet)).toHaveLength(0);
    await move(ids.shelf, hall);
    await settled();

    await firesTenMinutesAfter(core, token, quiet);
    // Nobody moved: the hall's motion came with its sensors.
    expect(await runsOf(core, token, inTheHall)).toHaveLength(0);
  });

  it("is quiet once, at the removal, however many of the room's sensors move with it", async () => {
    const { core, token, office, quiet } = await someoneAtTheDesk();
    await sees("motion-3", true);

    await post(core, "/api/places/rooms/remove", { id: office }, { token });
    await settled();

    await firesTenMinutesAfter(core, token, quiet);
    core.advance(30 * minute);
    await tick(core);
    expect(await runsOf(core, token, quiet)).toHaveLength(1);
  });

  it("is quiet from that moment when a sensor's last change isn't known", async () => {
    const home = await someoneAtTheDesk();
    const { core, token, ids, quiet } = home;
    core.db
      .update(deviceCapabilities)
      .set({ changedAt: null })
      .where(
        and(
          eq(deviceCapabilities.deviceId, ids.bed),
          eq(deviceCapabilities.kind, "motion"),
        ),
      )
      .run();

    await sees("motion-1", false);

    await firesTenMinutesAfter(core, token, quiet);
  });
});

describe("a zone whose rooms change otherwise", () => {
  it("keeps its countdown when it stays quiet", async () => {
    const { core, token, zone, bedroom, quiet } = await someoneAtTheDesk();
    await sees("motion-1", false);
    core.advance(5 * minute);

    await post(
      core,
      "/api/places/zones/update",
      { id: zone, roomIds: [bedroom] },
      { token },
    );
    await settled();

    // Ten minutes from the desk going quiet, not from the edit.
    core.advance(4 * minute);
    await tick(core);
    expect(await runsOf(core, token, quiet)).toHaveLength(0);
    core.advance(minute);
    await tick(core);
    expect(await runsOf(core, token, quiet)).toHaveLength(1);
  });

  it("stops counting when a room with motion joins it, and starts no motion trigger", async () => {
    const home = await someoneAtTheDesk();
    const { core, token, zone, office, bedroom, upstairs } = home;
    await post(
      core,
      "/api/places/zones/update",
      { id: zone, roomIds: [bedroom] },
      { token },
    );
    await settled();
    const inUpstairs = await home.workflow("motion", upstairs);
    core.advance(5 * minute);

    await post(
      core,
      "/api/places/zones/update",
      { id: zone, roomIds: [bedroom, office] },
      { token },
    );
    await settled();

    core.advance(30 * minute);
    await tick(core);
    expect(await runsOf(core, token, home.quiet)).toHaveLength(0);
    expect(await runsOf(core, token, inUpstairs)).toHaveLength(0);
  });

  it("stops counting once it's removed", async () => {
    const { core, token, zone, quiet } = await someoneAtTheDesk();
    await sees("motion-1", false);

    await post(core, "/api/places/zones/remove", { id: zone }, { token });
    await settled();

    core.advance(30 * minute);
    await tick(core);
    expect(await runsOf(core, token, quiet)).toHaveLength(0);
  });

  it("leaves the whole home as it was", async () => {
    const home = await someoneAtTheDesk();
    const { core, token, office } = home;
    const anywhere = await home.workflow("noMotion", { kind: "home" });
    await sees("motion-1", false);
    core.advance(5 * minute);

    await post(core, "/api/places/rooms/remove", { id: office }, { token });
    await settled();

    core.advance(4 * minute);
    await tick(core);
    expect(await runsOf(core, token, anywhere)).toHaveLength(0);
    core.advance(minute);
    await tick(core);
    expect(await runsOf(core, token, anywhere)).toHaveLength(1);
  });
});

describe("a place's kept motion", () => {
  // Whether a run by hand passes "no motion upstairs for ten minutes".
  async function quietUpstairs(
    core: TestCore,
    token: string,
    upstairs: object,
  ) {
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("hand", "manual"),
          {
            id: "if",
            kind: "condition",
            piece: "noMotion",
            config: { place: upstairs, forMinutes: 10 },
          },
          lightsOff("off", { kind: "home" }),
        ],
        edges: [
          { from: "hand", to: "if" },
          { from: "if", to: "off" },
        ],
      },
    });
    await runByHand(core, token, id);
    await core.workflows.settled();
    const [run] = await runsOf(core, token, id);
    return run!.status === "succeeded";
  }

  it("is what the no-motion condition reads", async () => {
    const { core, token, office, upstairs } = await someoneAtTheDesk();
    await post(core, "/api/places/rooms/remove", { id: office }, { token });
    await settled();

    core.advance(9 * minute);
    expect(await quietUpstairs(core, token, upstairs)).toBe(false);
    core.advance(minute);
    expect(await quietUpstairs(core, token, upstairs)).toBe(true);
  });

  it("is kept for a core that starts again on the same data", async () => {
    const { core, token, office, upstairs } = await someoneAtTheDesk();
    await post(core, "/api/places/rooms/remove", { id: office }, { token });
    await settled();
    const removedAt = core.now();
    core.advance(minute);

    const again = createMotion({
      db: core.db,
      devices: core.devices,
      places: core.places,
      now: core.now,
    });

    expect(again.at(upstairs)).toEqual({
      answering: true,
      motion: false,
      quietSince: removedAt,
    });
  });

  it("sets the timers of workflows that were held while it changed", async () => {
    const { core, token, office, quiet } = await someoneAtTheDesk();
    core.workflows.hold();

    await post(core, "/api/places/rooms/remove", { id: office }, { token });
    await settled();
    core.workflows.start({ ticking: false });

    await firesTenMinutesAfter(core, token, quiet);
  });
});
