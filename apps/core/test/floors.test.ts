import { describe, expect, it } from "vitest";

import { floors } from "../src/places/schema.js";
import { lampsCore, radio, settled } from "./devices-support.js";
import { claimed, get, post, testCore, type TestCore } from "./support.js";
import {
  addWorkflow,
  lightsOff,
  runByHand,
  runsOf,
  steps,
  trigger,
} from "./workflows-support.js";

// A floor as a place of its own: its lights, motion and light level are its
// rooms' together, workflows and the lights route take it, and a workflow
// that names a removed floor breaks. Floors keep the household's order, and
// what removing one takes with it is read first.

const minute = 60_000;

// Ground floor holds the living room and the kitchen, First floor the
// bedroom, and the hall is on no floor. The lamp is on in the living room,
// the counter light off in the kitchen, the bedroom light on; a motion
// sensor in the living room and one in the kitchen.
async function house() {
  const context = await lampsCore();
  const { core, maya } = context;
  const token = maya.token;
  const floor = async (name: string) =>
    (await post(core, "/api/places/floors/add", { name }, { token })).json()
      .id as string;
  const ground = await floor("Ground floor");
  const first = await floor("First floor");
  const room = async (name: string, floorId: string | null) =>
    (
      await post(core, "/api/places/rooms/add", { name, floorId }, { token })
    ).json().id as string;
  const living = await room("Living room", ground);
  const kitchen = await room("Kitchen", ground);
  const bedroom = await room("Bedroom", first);
  const hall = await room("Hall", null);
  await radio.add("counter-1", "light", "Counter");
  await radio.add("bed-1", "light", "Bed light");
  await radio.add("hall-1", "light", "Hall light");
  await radio.add("motion-1", "motion", "Sofa motion");
  await radio.add("motion-2", "motion", "Counter motion");
  await settled();
  const devices = (await get(core, "/api/devices", { token })).json() as {
    id: string;
    driverName: string;
  }[];
  const idOf = (name: string) =>
    devices.find((device) => device.driverName === name)!.id;
  for (const [id, roomId] of [
    [context.lamp, living],
    [idOf("Counter"), kitchen],
    [idOf("Bed light"), bedroom],
    [idOf("Hall light"), hall],
    [idOf("Sofa motion"), living],
    [idOf("Counter motion"), kitchen],
  ]) {
    await post(core, "/api/devices/update", { id, roomId }, { token });
  }
  await radio.press("lamp-1", { on: true });
  await radio.press("bed-1", { on: true });
  await radio.press("hall-1", { on: true });
  await settled();
  radio.received.length = 0;
  return { ...context, token, ground, first, living, kitchen, bedroom, hall };
}

const switched = () =>
  radio.received
    .map(({ command }) => [
      command.key,
      (command.command as { on: boolean }).on,
    ])
    .sort();

function lights(core: TestCore, token: string, body: unknown) {
  return post(core, "/api/devices/lights", body, { token });
}

describe("a floor's lights", () => {
  it("are its rooms' lights: off while any is on, then on room by room", async () => {
    const { core, token, ground } = await house();
    const off = await lights(core, token, {
      place: { kind: "floor", id: ground },
      to: "toggle",
    });
    expect(off.json()).toEqual({ on: false, switched: 1, failed: [] });
    expect(switched()).toEqual([["lamp-1", false]]);

    radio.received.length = 0;
    const on = await lights(core, token, {
      place: { kind: "floor", id: ground },
      to: "on",
    });
    expect(on.json()).toMatchObject({ on: true, switched: 2 });
    expect(switched()).toEqual([
      ["counter-1", true],
      ["lamp-1", true],
    ]);
  });

  it("follow a room moved onto or off the floor", async () => {
    const { core, token, ground, hall, living } = await house();
    await post(
      core,
      "/api/places/rooms/update",
      { id: hall, floorId: ground },
      { token },
    );
    await post(
      core,
      "/api/places/rooms/update",
      { id: living, floorId: null },
      { token },
    );
    await lights(core, token, {
      place: { kind: "floor", id: ground },
      to: "off",
    });
    expect(switched()).toEqual([["hall-1", false]]);
  });

  it("are refused for a floor the home does not have", async () => {
    const { core, token } = await house();
    const response = await lights(core, token, {
      place: { kind: "floor", id: "attic" },
      to: "off",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
    expect(radio.received).toEqual([]);
  });

  it("are what a workflow's lights condition and step read and switch", async () => {
    const { core, token, ground, first } = await house();
    const { id } = await addWorkflow(core, token, {
      graph: {
        version: 1,
        nodes: [
          trigger("trigger", "manual"),
          {
            id: "lit",
            kind: "condition",
            piece: "lights",
            config: { place: { kind: "floor", id: first }, are: "anyOn" },
          },
          lightsOff("off", { kind: "floor", id: ground }),
        ],
        edges: [
          { from: "trigger", to: "lit" },
          { from: "lit", to: "off" },
        ],
      },
    });
    await runByHand(core, token, id);
    await core.workflows.settled();
    expect((await runsOf(core, token, id))[0]).toMatchObject({
      status: "succeeded",
    });
    expect(switched()).toEqual([["lamp-1", false]]);
  });
});

describe("a floor's motion", () => {
  it("is its rooms' motion, quiet from the moment the room with motion leaves it", async () => {
    const { core, token, ground, living } = await house();
    // The kitchen has been quiet for two hours, the living room has motion.
    await radio.press("motion-2", { motion: false });
    await settled();
    core.advance(120 * minute);
    await radio.press("motion-1", { motion: true });
    await settled();
    const { id } = await addWorkflow(core, token, {
      graph: steps(
        trigger("quiet", "noMotion", {
          place: { kind: "floor", id: ground },
          forMinutes: 10,
        }),
        lightsOff("off", { kind: "floor", id: ground }),
      ),
    });

    await post(
      core,
      "/api/places/rooms/update",
      { id: living, floorId: null },
      { token },
    );
    await settled();
    core.advance(9 * minute);
    core.workflows.tick();
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(0);
    core.advance(minute);
    core.workflows.tick();
    await core.workflows.settled();
    expect(await runsOf(core, token, id)).toHaveLength(1);
  });
});

describe("floors' order", () => {
  it("puts a new floor after one at the highest explicit level", async () => {
    const core = await testCore();
    const person = await claimed(core);
    const roof = (
      await post(
        core,
        "/api/places/floors/add",
        { name: "Roof", level: 200 },
        person,
      )
    ).json();
    const outside = (
      await post(core, "/api/places/floors/add", { name: "Outside" }, person)
    ).json();

    expect((await get(core, "/api/places", person)).json().floors).toEqual([
      roof,
      outside,
    ]);
    expect(outside.level).toBeGreaterThan(roof.level);
  });

  it("can order every floor the home allows it to add", async () => {
    const core = await testCore();
    const person = await claimed(core);
    const at = new Date();
    const existing = Array.from({ length: 200 }, (_, level) => ({
      id: `floor-${level}`,
      name: `Floor ${level}`,
      level,
      createdAt: at,
      updatedAt: at,
    }));
    core.db.insert(floors).values(existing).run();
    const added = await post(
      core,
      "/api/places/floors/add",
      { name: "Roof" },
      person,
    );
    expect(added.statusCode).toBe(200);
    const ids = [added.json().id, ...existing.map((floor) => floor.id)];
    const ordered = await post(
      core,
      "/api/places/floors/order",
      { ids },
      person,
    );
    expect(ordered.statusCode).toBe(200);
    expect(ordered.json().map((floor: { id: string }) => floor.id)).toEqual(
      ids,
    );
  });

  it("puts a new floor last, and follows the household's order once set", async () => {
    const { core, token, ground, first } = await house();
    const outside = (
      await post(core, "/api/places/floors/add", { name: "Outside" }, { token })
    ).json();
    expect(outside.level).toBe(2);

    const ordered = await post(
      core,
      "/api/places/floors/order",
      { ids: [first, outside.id, ground] },
      { token },
    );
    expect(ordered.statusCode).toBe(200);
    const names = (await get(core, "/api/places", { token }))
      .json()
      .floors.map((floor: { name: string; level: number }) => [
        floor.name,
        floor.level,
      ]);
    expect(names).toEqual([
      ["First floor", 0],
      ["Outside", 1],
      ["Ground floor", 2],
    ]);
  });

  it("refuses an order that leaves a floor out, names one twice or one the home does not have", async () => {
    const { core, token, ground, first } = await house();
    for (const [ids, status, error] of [
      [[ground], 400, "invalid_order"],
      [[ground, first, first], 400, "invalid_order"],
      [[ground, first, "attic"], 404, "not_found"],
    ] as const) {
      const response = await post(
        core,
        "/api/places/floors/order",
        { ids },
        { token },
      );
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error });
    }
  });
});

describe("removing a floor", () => {
  it("says first that its rooms stay and which workflows name it, then breaks those", async () => {
    const { core, token, ground } = await house();
    const { id } = await addWorkflow(core, token, {
      name: "Downstairs off",
      graph: steps(
        trigger("trigger", "manual"),
        lightsOff("off", { kind: "floor", id: ground }),
      ),
    });

    const removal = await get(core, `/api/places/floors/removal?id=${ground}`, {
      token,
    });
    expect(removal.json()).toEqual({
      rooms: [
        { id: expect.any(String), name: "Kitchen" },
        { id: expect.any(String), name: "Living room" },
      ],
      workflows: [{ id, name: "Downstairs off" }],
    });

    await post(core, "/api/places/floors/remove", { id: ground }, { token });
    const rooms = (await get(core, "/api/places", { token })).json().rooms;
    expect(
      rooms.map((room: { name: string; floorId: string | null }) => [
        room.name,
        room.floorId,
      ]),
    ).toEqual(expect.arrayContaining([["Kitchen", null]]));
    await runByHand(core, token, id);
    await core.workflows.settled();
    expect((await runsOf(core, token, id))[0]).toMatchObject({
      status: "skipped",
      reason: "broken",
      error: "The floor it names was removed",
    });
    expect(radio.received).toEqual([]);
  });

  it("reads nothing for a floor the home does not have", async () => {
    const { core, token } = await house();
    const response = await get(core, "/api/places/floors/removal?id=attic", {
      token,
    });
    expect(response.statusCode).toBe(404);
  });
});
