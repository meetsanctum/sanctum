import { describe, expect, it } from "vitest";

import { createMood, listMoods } from "../../src/moods/actions.js";
import { assignSmartMood } from "../../src/moods/smart-actions.js";
import { startableHome } from "./core.js";
import { device, lightCapability } from "./home.js";

// A room's moods go with the room: Moods follows place.deleted while it
// runs, and on start removes the moods of rooms deleted while it was
// stopped, and their entities with them.

const homeDevices = [
  device("desk", "office", [lightCapability({ on: true, brightness: 60 })]),
  device("counter", "kitchen", [lightCapability({ on: true, brightness: 50 })]),
];
const desk = [{ device: "desk", capability: "light", state: { on: true } }];
const counter = [
  { device: "counter", capability: "light", state: { on: true } },
];

function home() {
  const started = startableHome({ devices: homeDevices });
  return {
    ...started,
    async lightRows() {
      return started.storage.query({
        sql: "select mood_id from mood_lights",
        params: [],
        method: "all",
      });
    },
  };
}

async function moodsIn(
  call: ReturnType<typeof startableHome>["call"],
): Promise<[string, string][]> {
  return (await call(listMoods, {})).map((mood) => [mood.roomId, mood.name]);
}

describe("a room's moods", () => {
  it("go when the room is deleted, smart ones too, while other rooms keep theirs", async () => {
    const { start, call, deleteRoom, lightRows, state } = home();
    await start();
    const relax = await call(createMood, {
      roomId: "office",
      name: "Relax",
      lights: desk,
    });
    await call(assignSmartMood, { roomId: "office", definitionId: "aurora" });
    const cooking = await call(createMood, {
      roomId: "kitchen",
      name: "Cooking",
      lights: counter,
    });

    expect(state.followed).toContain("place.deleted");
    await deleteRoom("office");

    expect(await moodsIn(call)).toEqual([["kitchen", "Cooking"]]);
    // Their lights and their entities went with them.
    const { rows } = await lightRows();
    expect(rows).not.toContainEqual([relax.id]);
    expect(rows).toHaveLength(1);
    expect([...state.entities.keys()]).toEqual([cooking.id]);
  });

  it("stay when another kind of place is deleted", async () => {
    const { start, call, hand, state } = home();
    await start();
    const relax = await call(createMood, {
      roomId: "office",
      name: "Relax",
      lights: desk,
    });

    await hand({
      name: "place.deleted",
      place: { kind: "zone", id: "office", name: "Office", roomIds: [] },
    });

    expect(await moodsIn(call)).toEqual([["office", "Relax"]]);
    expect([...state.entities.keys()]).toEqual([relax.id]);
  });

  it("go on start for rooms deleted while Moods was stopped", async () => {
    const { start, call, state } = home();
    await call(createMood, { roomId: "office", name: "Relax", lights: desk });
    await call(assignSmartMood, { roomId: "office", definitionId: "aurora" });
    const cooking = await call(createMood, {
      roomId: "kitchen",
      name: "Cooking",
      lights: counter,
    });
    expect(state.entities.size).toBe(3);
    state.places.rooms = state.places.rooms.filter(
      (room) => room.id !== "office",
    );

    await start();

    expect(await moodsIn(call)).toEqual([["kitchen", "Cooking"]]);
    expect([...state.entities.keys()]).toEqual([cooking.id]);
  });

  it("all go on start when the home has no rooms left", async () => {
    const { start, call, state, storage } = home();
    await call(createMood, { roomId: "office", name: "Relax", lights: desk });
    await call(createMood, {
      roomId: "kitchen",
      name: "Cooking",
      lights: counter,
    });
    state.places.rooms = [];

    await start();

    expect(await call(listMoods, {})).toEqual([]);
    expect(state.entities.size).toBe(0);
    // Nothing is left behind for a room of the same id made later.
    expect(
      await storage.query({
        sql: "select count(*) from moods",
        params: [],
        method: "values",
      }),
    ).toEqual({ rows: [[0]] });
  });
});
