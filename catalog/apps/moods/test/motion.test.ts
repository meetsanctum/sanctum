import type { WorkflowInfo } from "@meetsanctum/app-sdk";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it, vi } from "vitest";

import { listMotion, setMotion } from "../src/motion/actions.js";
import {
  changeMotion,
  readMotion,
  workflowsFor,
} from "../src/motion/motion.js";
import { startableHome } from "./moods/core.js";
import {
  device,
  illuminanceCapability,
  lightCapability,
  occupancyCapability,
} from "./moods/home.js";

// What motion does to a room's lights (motion/): the choices in Moods'
// database, and the workflows Moods keeps from them, put while a switch is
// on and removed once it is off, from the core's motion and lights pieces.

const office = { kind: "room", id: "office" };

const lamp = () =>
  device("lamp", "office", [lightCapability({ on: false, brightness: 60 })]);
// A motion sensor, and one that reads the light level too.
const sensor = (id: string, room: string) =>
  device(id, room, [occupancyCapability(false)]);
const sensorWithLight = (id: string, room: string, lux: number | null = 320) =>
  device(id, room, [occupancyCapability(false), illuminanceCapability(lux)]);

function home(devices = [lamp(), sensorWithLight("office-motion", "office")]) {
  const started = startableHome({ devices });
  // Moods' own database, as its actions reach it.
  const db = drizzle(async (sql, params, method) => {
    const { rows } = await started.storage.query({ sql, params, method });
    return { rows: rows as unknown[] };
  });
  return {
    ...started,
    db,
    workflow: (key: string) => started.state.workflows.get(key),
    keys: () => [...started.state.workflows.keys()].sort(),
  };
}

// A workflow's nodes as piece and config, in the order they lead.
const steps = (workflow: WorkflowInfo | undefined) =>
  workflow?.graph.nodes.map(({ kind, piece, config }) => ({
    kind,
    piece,
    config,
  }));

describe("what motion does to a room", () => {
  it("is nothing at first, in every room", async () => {
    const { start, call, keys } = home();
    await start();
    expect(await call(listMotion, {})).toEqual([
      { roomId: "office", turnOn: false, darkerThan: null, turnOffAfter: null },
      {
        roomId: "kitchen",
        turnOn: false,
        darkerThan: null,
        turnOffAfter: null,
      },
    ]);
    expect(keys()).toEqual([]);
  });

  it("turns the lights on with motion while every light is off, as turning the room on brings", async () => {
    const { start, call, workflow } = home();
    await start();
    expect(await call(setMotion, { roomId: "office", turnOn: true })).toEqual({
      roomId: "office",
      turnOn: true,
      darkerThan: null,
      turnOffAfter: null,
    });
    const kept = workflow("motion-on:office");
    expect(kept).toMatchObject({
      name: "Office lights on with motion",
      appKey: "motion-on:office",
    });
    expect(steps(kept)).toEqual([
      { kind: "trigger", piece: "motion", config: { place: office } },
      {
        kind: "condition",
        piece: "lights",
        config: { place: office, are: "allOff" },
      },
      { kind: "step", piece: "lights", config: { place: office, to: "on" } },
    ]);
    expect(kept?.graph.edges).toEqual([
      { from: "motion", to: "allOff" },
      { from: "allOff", to: "on" },
    ]);
  });

  it("asks the room's light level only when a level is chosen", async () => {
    const { start, call, workflow } = home();
    await start();
    await call(setMotion, { roomId: "office", turnOn: true, darkerThan: 30 });
    expect(steps(workflow("motion-on:office"))).toEqual([
      { kind: "trigger", piece: "motion", config: { place: office } },
      {
        kind: "condition",
        piece: "lights",
        config: { place: office, are: "allOff" },
      },
      {
        kind: "condition",
        piece: "lightLevel",
        config: { place: office, is: "darker", lux: 30 },
      },
      { kind: "step", piece: "lights", config: { place: office, to: "on" } },
    ]);
    expect(workflow("motion-on:office")?.graph.edges).toEqual([
      { from: "motion", to: "allOff" },
      { from: "allOff", to: "darker" },
      { from: "darker", to: "on" },
    ]);

    await call(setMotion, { roomId: "office", darkerThan: null });
    expect(
      steps(workflow("motion-on:office"))?.map((node) => node.piece),
    ).toEqual(["motion", "lights", "lights"]);
  });

  it("turns every light off after the minutes chosen with no motion, while any is on", async () => {
    const { start, call, workflow } = home();
    await start();
    await call(setMotion, { roomId: "office", turnOffAfter: 10 });
    const kept = workflow("motion-off:office");
    expect(kept).toMatchObject({ name: "Office lights off with no motion" });
    expect(steps(kept)).toEqual([
      {
        kind: "trigger",
        piece: "noMotion",
        config: { place: office, forMinutes: 10 },
      },
      {
        kind: "condition",
        piece: "lights",
        config: { place: office, are: "anyOn" },
      },
      { kind: "step", piece: "lights", config: { place: office, to: "off" } },
    ]);

    await call(setMotion, { roomId: "office", turnOffAfter: 2 });
    expect(workflow("motion-off:office")?.graph.nodes[0]?.config).toEqual({
      place: office,
      forMinutes: 2,
    });
  });

  it("keeps each choice apart, and removes a workflow once its switch is off", async () => {
    const { start, call, keys } = home([
      lamp(),
      sensorWithLight("office-motion", "office"),
      sensor("kitchen-motion", "kitchen"),
    ]);
    await start();
    await call(setMotion, { roomId: "office", turnOn: true, darkerThan: 10 });
    await call(setMotion, { roomId: "office", turnOffAfter: 5 });
    await call(setMotion, { roomId: "kitchen", turnOn: true });
    expect(keys()).toEqual([
      "motion-off:office",
      "motion-on:kitchen",
      "motion-on:office",
    ]);

    expect(await call(setMotion, { roomId: "office", turnOn: false })).toEqual({
      roomId: "office",
      turnOn: false,
      darkerThan: 10,
      turnOffAfter: 5,
    });
    expect(keys()).toEqual(["motion-off:office", "motion-on:kitchen"]);
    await call(setMotion, { roomId: "office", turnOffAfter: null });
    expect(keys()).toEqual(["motion-on:kitchen"]);
  });

  it("is not started in a room no motion sensor sees, and is always stopped", async () => {
    const { start, call, db, keys } = home([lamp()]);
    await start();
    await expect(
      call(setMotion, { roomId: "office", turnOn: true }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      call(setMotion, { roomId: "office", turnOffAfter: 10 }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(keys()).toEqual([]);

    // On while it had one, the sensor since removed: it still turns off.
    await changeMotion(db, "office", { turnOn: true });
    expect(await call(setMotion, { roomId: "office", turnOn: false })).toEqual({
      roomId: "office",
      turnOn: false,
      darkerThan: null,
      turnOffAfter: null,
    });
  });

  it("refuses a room the home doesn't have, and a choice it doesn't offer", async () => {
    const { start, call } = home();
    await start();
    await expect(
      call(setMotion, { roomId: "attic", turnOn: true }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      call(setMotion, { roomId: "office", darkerThan: 20 as 10 }),
    ).rejects.toThrow();
    await expect(
      call(setMotion, { roomId: "office", turnOffAfter: 3 as 2 }),
    ).rejects.toThrow();
    await expect(call(setMotion, { roomId: "office" })).rejects.toThrow();
  });

  it("puts the choices and the workflows back when a workflow can't be put", async () => {
    const { start, call, state, keys } = home();
    await start();
    await call(setMotion, { roomId: "office", turnOn: true });
    const before = structuredClone(state.workflows.get("motion-on:office"));
    state.failWorkflowPuts = 1;

    await expect(
      call(setMotion, { roomId: "office", turnOffAfter: 10 }),
    ).rejects.toThrow("workflow put failed");

    expect(await call(listMotion, { roomId: "office" })).toEqual([
      { roomId: "office", turnOn: true, darkerThan: null, turnOffAfter: null },
    ]);
    expect(keys()).toEqual(["motion-on:office"]);
    expect(state.workflows.get("motion-on:office")).toEqual(before);
  });
});

describe("the workflows motion runs", () => {
  it("run once at a time, one for each switch that is on", () => {
    const wanted = workflowsFor(
      { roomId: "office", turnOn: true, darkerThan: 5, turnOffAfter: 30 },
      { id: "office", name: "Office" },
      [sensorWithLight("office-motion", "office")],
    );
    expect(
      wanted.map(({ key, name, runMode }) => ({ key, name, runMode })),
    ).toEqual([
      {
        key: "motion-on:office",
        name: "Office lights on with motion",
        runMode: "single",
      },
      {
        key: "motion-off:office",
        name: "Office lights off with no motion",
        runMode: "single",
      },
    ]);
  });

  it("leave the light level out while no sensor in the room reads it, and take it in once one does", async () => {
    const { start, call, workflow, addDevice, removeDevice, changeDevice } =
      home([lamp(), sensor("office-motion", "office")]);
    await start();
    await call(setMotion, { roomId: "office", turnOn: true, darkerThan: 30 });
    const pieces = () =>
      steps(workflow("motion-on:office"))?.map((node) => node.piece);
    expect(pieces()).toEqual(["motion", "lights", "lights"]);

    await addDevice(
      device("office-light", "office", [illuminanceCapability(80)]),
    );
    expect(pieces()).toEqual(["motion", "lights", "lightLevel", "lights"]);

    // A reading changes nothing; moving the sensor out does.
    await changeDevice("office-light", (each) => {
      each.capabilities[0] = illuminanceCapability(12);
    });
    expect(pieces()).toEqual(["motion", "lights", "lightLevel", "lights"]);
    await changeDevice("office-light", (each) => {
      each.roomId = "kitchen";
    });
    expect(pieces()).toEqual(["motion", "lights", "lights"]);

    await changeDevice("office-light", (each) => {
      each.roomId = "office";
    });
    await removeDevice("office-light");
    expect(pieces()).toEqual(["motion", "lights", "lights"]);
  });

  it("are named after the room, again when it is renamed", async () => {
    const { start, call, state, hand, workflow } = home();
    await start();
    await call(setMotion, { roomId: "office", turnOn: true, turnOffAfter: 15 });
    const room = state.places.rooms.find((each) => each.id === "office")!;
    const before = { kind: "room" as const, ...room };
    room.name = "Study";
    await hand({
      name: "place.changed",
      place: { kind: "room", ...room },
      before,
    });
    expect(workflow("motion-on:office")?.name).toBe(
      "Study lights on with motion",
    );
    expect(workflow("motion-off:office")?.name).toBe(
      "Study lights off with no motion",
    );
  });

  it("keep a long room name within the core's limit", async () => {
    const { start, call, state, workflow } = home();
    state.places.rooms[0]!.name = "A".repeat(120);
    await start();
    await call(setMotion, { roomId: "office", turnOffAfter: 5 });
    const name = workflow("motion-off:office")!.name;
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(" lights off with no motion")).toBe(true);
  });

  it("go with the room, and its choices with them", async () => {
    const { start, call, deleteRoom, keys, storage } = home([
      lamp(),
      sensorWithLight("office-motion", "office"),
      sensor("kitchen-motion", "kitchen"),
    ]);
    await start();
    await call(setMotion, { roomId: "office", turnOn: true, turnOffAfter: 5 });
    await call(setMotion, { roomId: "kitchen", turnOffAfter: 30 });

    await deleteRoom("office");

    expect(keys()).toEqual(["motion-off:kitchen"]);
    const { rows } = await storage.query({
      sql: "select room_id from motion_settings",
      params: [],
      method: "all",
    });
    expect(rows).toEqual([["kitchen"]]);
  });

  it("are put again on start, for a room deleted meanwhile removed, and stray ones taken out", async () => {
    const first = home();
    await first.start();
    await first.call(setMotion, {
      roomId: "office",
      turnOn: true,
      darkerThan: 50,
    });
    await first.call(setMotion, { roomId: "office", turnOffAfter: 60 });
    // The core lost one, and keeps one for a room whose choice is gone.
    first.state.workflows.delete("motion-on:office");
    const stray = structuredClone(
      first.state.workflows.get("motion-off:office")!,
    );
    first.state.workflows.set("motion-off:kitchen", {
      ...stray,
      appKey: "motion-off:kitchen",
    });

    await first.start();
    expect(first.keys()).toEqual(["motion-off:office", "motion-on:office"]);
    expect(
      steps(first.workflow("motion-on:office"))?.[2]?.config,
    ).toMatchObject({ lux: 50 });

    // Deleted while Moods was stopped: start forgets it.
    first.state.places.rooms = first.state.places.rooms.filter(
      (each) => each.id !== "office",
    );
    await first.start();
    expect(first.keys()).toEqual([]);
    expect(await readMotion(first.db)).toEqual([]);
  });

  it("leave every other workflow Moods keeps alone", async () => {
    const remote = device("remote", "office", [
      {
        id: "button",
        kind: "button",
        features: { actions: ["single"], holds: [] },
        state: null,
        observed: null,
        desired: null,
        sync: "synced",
        setBy: null,
        changedAt: null,
      },
    ]);
    const { start, call, keys } = home([
      lamp(),
      sensor("office-motion", "office"),
      remote,
    ]);
    await start();
    await call(setMotion, { roomId: "office", turnOn: true });
    await call(setMotion, { roomId: "office", turnOn: false });
    expect(keys()).toEqual(["default:remote"]);
  });
});

describe("motion while a permission is off", () => {
  it("pauses motion even when syncing a remote fails", async () => {
    const remote = device("remote", "office", [
      {
        id: "button",
        kind: "button",
        features: { actions: ["single"], holds: [] },
        state: null,
        observed: null,
        desired: null,
        sync: "synced",
        setBy: null,
        changedAt: null,
      },
    ]);
    const { start, call, state, grant, keys } = home([
      lamp(),
      sensorWithLight("office-motion", "office"),
      remote,
    ]);
    await start();
    await call(setMotion, { roomId: "office", turnOn: true, darkerThan: 30 });
    state.failWorkflowPuts = 1;

    await expect(grant("devices.read:sensor", false)).rejects.toThrow(
      "workflow put failed",
    );
    expect(keys()).toEqual(["default:remote"]);
  });

  it("never drops the light condition when permission is lost during a sync", async () => {
    const { start, call, state, holdDevices, grant, keys } = home();
    await start();
    await call(setMotion, { roomId: "office", turnOn: true, darkerThan: 30 });
    const puts = vi.spyOn(state.workflows, "set");

    const hold = holdDevices();
    const changing = call(setMotion, { roomId: "office", darkerThan: 10 });
    await hold.reached;
    const pausing = grant("devices.read:sensor", false);
    hold.release();
    await Promise.all([changing, pausing]);

    expect(keys()).toEqual([]);
    expect(
      puts.mock.calls.filter(
        ([key, workflow]) =>
          key === "motion-on:office" &&
          !workflow.graph.nodes.some((node) => node.piece === "lightLevel"),
      ),
    ).toEqual([]);
    expect(await call(listMotion, { roomId: "office" })).toEqual([
      { roomId: "office", turnOn: true, darkerThan: 10, turnOffAfter: null },
    ]);
  });

  it("pauses with motion sensors out of sight, and keeps what the household chose", async () => {
    const { start, call, keys, grant } = home();
    await start();
    await call(setMotion, { roomId: "office", turnOn: true, turnOffAfter: 5 });
    expect(keys()).toEqual(["motion-off:office", "motion-on:office"]);

    await grant("devices.read:occupancy", false);
    expect(keys()).toEqual([]);
    expect(
      (await call(listMotion, {})).find((room) => room.roomId === "office"),
    ).toEqual({
      roomId: "office",
      turnOn: true,
      darkerThan: null,
      turnOffAfter: 5,
    });

    await grant("devices.read:occupancy", true);
    expect(keys()).toEqual(["motion-off:office", "motion-on:office"]);
  });

  it("pauses turning on only when dark while light levels are out of sight, rather than turning on whatever the light", async () => {
    const { start, call, keys, workflow, grant } = home();
    await start();
    await call(setMotion, {
      roomId: "office",
      turnOn: true,
      darkerThan: 30,
      turnOffAfter: 5,
    });

    await grant("devices.read:sensor", false);
    // Turning off needs no light level, so it goes on.
    expect(keys()).toEqual(["motion-off:office"]);

    await grant("devices.read:sensor", true);
    expect(
      steps(workflow("motion-on:office"))?.map((node) => node.piece),
    ).toEqual(["motion", "lights", "lightLevel", "lights"]);
  });

  it("changes nothing without its own automations, and starts without them", async () => {
    const started = home();
    await started.start();
    await started.call(setMotion, { roomId: "office", turnOn: true });

    await started.grant("workflows.manage", false);
    expect(started.keys()).toEqual(["motion-on:office"]);

    const again = home();
    again.state.granted = ["places.read", "devices.control:light"];
    await expect(again.start()).resolves.toBeUndefined();
    expect(again.keys()).toEqual([]);
  });
});
