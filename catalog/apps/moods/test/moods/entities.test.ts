import type {
  CapabilityInfo,
  DeviceInfo,
  LightState,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  createMood,
  deleteMood,
  listMoods,
  orderMoods,
  updateMood,
} from "../../src/moods/actions.js";
import type { MoodState } from "../../src/moods/entities.js";
import { assignSmartMood } from "../../src/moods/smart-actions.js";
import { startableHome } from "./core.js";
import { device, lightCapability } from "./home.js";

// Moods publishes each mood as a moods.mood entity, in the tile shape room
// sections draw, with whether the room's lights show it: on every change to
// its moods, as its rooms' lights change, and on start for whatever changed
// while it was stopped.

const fan = (on: boolean): CapabilityInfo => ({
  id: "switch",
  kind: "switch",
  features: {},
  state: { on },
  observed: { on },
  desired: null,
  sync: "synced",
  setBy: null,
  changedAt: null,
});

const homeDevices = () => [
  device("desk", "office", [lightCapability({ on: true, brightness: 40 })]),
  device("ceiling", "office", [lightCapability({ on: false })]),
  device("counter", "kitchen", [lightCapability({ on: true, brightness: 50 })]),
  device("fan", "office", [fan(false)]),
];

const reading = [
  { device: "desk", capability: "light", state: { on: true, brightness: 40 } },
  { device: "ceiling", capability: "light", state: { on: false } },
];
const bright = [
  { device: "desk", capability: "light", state: { on: true, brightness: 100 } },
  {
    device: "ceiling",
    capability: "light",
    state: { on: true, brightness: 100 },
  },
];
const cooking = [
  {
    device: "counter",
    capability: "light",
    state: { on: true, brightness: 50 },
  },
];

// A change that sets a device's light to a state.
const showing = (state: LightState) => (device: DeviceInfo) => {
  device.capabilities = [lightCapability(state)];
};

function home() {
  const started = startableHome({ devices: homeDevices() });
  const { state } = started;
  return {
    ...started,
    /** A mood's entity as the home has it. */
    entity(id: string) {
      const entity = state.entities.get(id);
      return entity && { ...entity, state: entity.state as MoodState };
    },
    /** Whether each mood is active, by name, in the home's entities. */
    active() {
      return Object.fromEntries(
        [...state.entities.values()].map((entity) => [
          entity.name,
          (entity.state as MoodState).active,
        ]),
      );
    },
  };
}

describe("moods.mood entities", () => {
  it("are published in the tile shape room sections draw as moods are made", async () => {
    const { start, call, entity } = home();
    await start();

    const read = await call(createMood, {
      roomId: "office",
      name: "Reading",
      icon: "book-open",
      lights: reading,
    });
    expect(entity(read.id)).toEqual({
      type: "moods.mood",
      key: read.id,
      name: "Reading",
      state: {
        placeId: "office",
        icon: "book-open",
        name: "Reading",
        order: 0,
        active: true,
        input: { id: read.id },
      },
    });

    const lit = await call(createMood, {
      roomId: "office",
      name: "Bright",
      lights: bright,
    });
    const aurora = await call(assignSmartMood, {
      roomId: "office",
      definitionId: "aurora",
    });
    const cook = await call(createMood, {
      roomId: "kitchen",
      name: "Cooking",
      lights: cooking,
    });
    expect(entity(lit.id)?.state).toMatchObject({ order: 1, active: false });
    expect(entity(aurora.id)?.state).toMatchObject({
      placeId: "office",
      name: "Aurora",
      icon: "sparkles",
      order: 2,
      active: false,
    });
    expect(entity(cook.id)?.state).toMatchObject({
      placeId: "kitchen",
      order: 0,
      active: true,
    });
  });

  it("follow a mood's changes, its room's order and its deletion", async () => {
    const { start, call, entity, state } = home();
    await start();
    const read = await call(createMood, {
      roomId: "office",
      name: "Reading",
      lights: reading,
    });
    const lit = await call(createMood, {
      roomId: "office",
      name: "Bright",
      lights: bright,
    });

    await call(updateMood, { id: read.id, name: "Evening", icon: "moon" });
    expect(entity(read.id)).toMatchObject({
      name: "Evening",
      state: { name: "Evening", icon: "moon", order: 0 },
    });

    await call(orderMoods, { roomId: "office", moodIds: [lit.id] });
    expect(entity(lit.id)?.state.order).toBe(0);
    expect(entity(read.id)?.state.order).toBe(1);

    await call(deleteMood, { id: lit.id });
    expect([...state.entities.keys()]).toEqual([read.id]);
    expect(entity(read.id)?.state.order).toBe(0);
  });

  it("are active while the room's lights show them, offline lights aside", async () => {
    const { start, call, changeDevice, addDevice, removeDevice, active } =
      home();
    await start();
    await call(createMood, {
      roomId: "office",
      name: "Reading",
      lights: reading,
    });
    await call(createMood, {
      roomId: "office",
      name: "Bright",
      lights: bright,
    });
    await call(assignSmartMood, { roomId: "office", definitionId: "aurora" });
    expect(active()).toEqual({ Reading: true, Bright: false, Aurora: false });

    await changeDevice("desk", showing({ on: true, brightness: 80 }));
    expect(active()).toEqual({ Reading: false, Bright: false, Aurora: false });
    // Within a level of 2, as v1 allowed.
    await changeDevice("desk", showing({ on: true, brightness: 41 }));
    expect(active()).toEqual({ Reading: true, Bright: false, Aurora: false });

    // Every other light in the room must be off, unless it is offline.
    await changeDevice("ceiling", showing({ on: true, brightness: 10 }));
    expect(active().Reading).toBe(false);
    await changeDevice("ceiling", (ceiling) => {
      ceiling.availability = "offline";
    });
    expect(active().Reading).toBe(true);

    // A light that joins the room on, and leaves it again.
    await addDevice(
      device("lamp", "office", [lightCapability({ on: true, brightness: 5 })]),
    );
    expect(active().Reading).toBe(false);
    await removeDevice("lamp");
    expect(active().Reading).toBe(true);

    // A smart mood follows the room's lights as they are.
    await changeDevice("ceiling", (ceiling) => {
      ceiling.availability = "online";
      ceiling.capabilities = [lightCapability({ on: true, brightness: 70 })];
    });
    await changeDevice("desk", showing({ on: true, brightness: 70 }));
    expect(active()).toEqual({ Reading: false, Bright: false, Aurora: true });
  });

  it("change in both rooms when a light moves between them", async () => {
    const { start, call, changeDevice, active } = home();
    await start();
    await call(createMood, {
      roomId: "office",
      name: "Reading",
      lights: reading,
    });
    await call(createMood, {
      roomId: "kitchen",
      name: "Cooking",
      lights: cooking,
    });
    expect(active()).toEqual({ Reading: true, Cooking: true });

    await changeDevice("counter", (counter) => {
      counter.roomId = "office";
    });

    // The office has a light on that Reading keeps off; the kitchen has
    // none of Cooking's lights left.
    expect(active()).toEqual({ Reading: false, Cooking: false });
  });

  it("follow mood edits", async () => {
    const { start, call, changeDevice, active } = home();
    await start();
    const read = await call(createMood, {
      roomId: "office",
      name: "Reading",
      lights: reading,
    });
    await changeDevice("desk", showing({ on: true, brightness: 80 }));
    expect(active().Reading).toBe(false);

    await call(updateMood, {
      id: read.id,
      lights: [
        {
          device: "desk",
          capability: "light",
          state: { on: true, brightness: 80 },
        },
      ],
    });

    expect(active().Reading).toBe(true);
  });

  it("are none of them active while several match", async () => {
    const { start, call, active, entity } = home();
    await start();
    const read = await call(createMood, {
      roomId: "office",
      name: "Reading",
      lights: reading,
    });
    const again = await call(createMood, {
      roomId: "office",
      name: "Reading again",
      lights: reading,
    });
    expect(active()).toEqual({ Reading: false, "Reading again": false });

    await call(deleteMood, { id: again.id });

    expect(entity(read.id)?.state.active).toBe(true);
  });

  it("are published only when they change", async () => {
    const { start, call, changeDevice, state } = home();
    await start();
    await call(createMood, {
      roomId: "office",
      name: "Reading",
      lights: reading,
    });
    await call(createMood, {
      roomId: "office",
      name: "Bright",
      lights: bright,
    });
    const published = state.publications;

    // A light that still shows Reading, a switch, a room without moods.
    await changeDevice("desk", showing({ on: true, brightness: 39 }));
    await changeDevice("fan", (device) => {
      device.capabilities = [fan(true)];
    });
    await changeDevice("counter", showing({ on: false }));
    expect(state.publications).toBe(published);

    // Reading stops showing; Bright was not active and is not now.
    await changeDevice("desk", showing({ on: true, brightness: 80 }));
    expect(state.publications).toBe(published + 1);
  });

  it("retry a failed first publication on the next light event", async () => {
    const { start, call, changeDevice, state, entity } = home();
    await start();
    state.refusing = true;
    await expect(
      call(createMood, {
        roomId: "office",
        name: "Reading",
        lights: reading,
      }),
    ).rejects.toThrow();
    const [read] = await call(listMoods, { roomId: "office" });
    expect(entity(read!.id)).toBeUndefined();

    state.refusing = false;
    await changeDevice("desk", showing({ on: true, brightness: 39 }));

    expect(entity(read!.id)).toMatchObject({
      name: "Reading",
      state: { active: true },
    });
  });

  it("retry a failed update even when its computed state has not changed", async () => {
    const { start, call, changeDevice, state, entity } = home();
    await start();
    const read = await call(createMood, {
      roomId: "office",
      name: "Reading",
      lights: reading,
    });
    state.refusing = true;
    await expect(
      call(updateMood, { id: read.id, name: "Evening" }),
    ).rejects.toThrow();
    expect(entity(read.id)?.name).toBe("Reading");

    state.refusing = false;
    await changeDevice("desk", showing({ on: true, brightness: 39 }));

    expect(entity(read.id)).toMatchObject({
      name: "Evening",
      state: { name: "Evening", active: true },
    });
    const published = state.publications;
    await changeDevice("desk", showing({ on: true, brightness: 40 }));
    expect(state.publications).toBe(published);
  });

  it("catch up on start with what changed while Moods was stopped", async () => {
    const { start, call, state, entity } = home();
    const read = await call(createMood, {
      roomId: "office",
      name: "Reading",
      lights: reading,
    });
    const lit = await call(createMood, {
      roomId: "office",
      name: "Bright",
      lights: bright,
    });
    const cook = await call(createMood, {
      roomId: "kitchen",
      name: "Cooking",
      lights: cooking,
    });
    // A deletion whose entity the core would not take out.
    state.refusing = true;
    await expect(call(deleteMood, { id: lit.id })).rejects.toThrow();
    state.refusing = false;
    expect(state.entities.has(lit.id)).toBe(true);
    // While stopped: the desk changed unheard, and the home lost Cooking.
    state.devices[0]!.capabilities = [
      lightCapability({ on: true, brightness: 100 }),
    ];
    state.entities.delete(cook.id);

    await start();

    expect([...state.entities.keys()].sort()).toEqual(
      [read.id, cook.id].sort(),
    );
    expect(entity(read.id)?.state).toMatchObject({ order: 0, active: false });
    expect(entity(cook.id)?.state.active).toBe(true);
  });

  it("never land a room read before a change after one read since", async () => {
    const { start, call, changeDevice, holdDevices, entity } = home();
    await start();
    const read = await call(createMood, {
      roomId: "office",
      name: "Reading",
      lights: reading,
    });

    // The desk's report reads the room, then waits for the devices…
    const held = holdDevices();
    const reported = changeDevice(
      "desk",
      showing({ on: true, brightness: 80 }),
    );
    await held.reached;
    // …while the mood is renamed, and its rename waits its turn.
    const renamed = call(updateMood, { id: read.id, name: "Evening" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    held.release();
    await Promise.all([reported, renamed]);

    expect(entity(read.id)).toMatchObject({
      name: "Evening",
      state: { name: "Evening", active: false },
    });
  });
});
