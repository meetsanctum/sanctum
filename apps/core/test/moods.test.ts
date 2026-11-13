import moods from "@meetsanctum/moods";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { AppPackage } from "./runner-apps.js";
import { lampsCore, radio, settled } from "./devices-support.js";
import { get, post, sharedClient, testCore, type TestCore } from "./support.js";

// Moods on the core, end to end: a room's moods are counted before the room is
// removed, and go with it, through place.deleted while Moods runs, and when it
// starts for a room deleted while it did not; and turning a room on brings back
// what it was when it went dark, through the lights.turnOn Moods publishes.

const moodsPackage: AppPackage = {
  app: moods,
  origin: "official",
  migrationsFolder: fileURLToPath(
    new URL("../../../catalog/apps/moods/migrations", import.meta.url),
  ),
};

function call(core: TestCore, token: string, action: string, input: object) {
  return post(core, `/api/apps/sanctum.moods/actions/${action}`, input, {
    token,
  });
}

async function home() {
  const context = await lampsCore({ apps: [moodsPackage] });
  const { core, maya, lamp } = context;
  const room = async (name: string) =>
    (await post(core, "/api/places/rooms/add", { name }, maya)).json().id;
  const office = await room("Office");
  const kitchen = await room("Kitchen");
  for (const roomId of [office, kitchen]) {
    const created = await call(core, maya.token, "moods.createMood", {
      roomId,
      name: "Relax",
      lights: [{ device: lamp, capability: "light", state: { on: true } }],
    });
    expect(created.statusCode).toBe(200);
  }
  const moodRooms = async (on: TestCore = core) =>
    (await call(on, maya.token, "moods.moods", {}))
      .json()
      .map((mood: { roomId: string }) => mood.roomId);
  return { ...context, office, kitchen, moodRooms };
}

describe("Moods", () => {
  it("lets a shared tablet see and change a room's moods, published at once", async () => {
    const { core, maya, office, lamp } = await home();
    await post(core, "/api/devices/update", { id: lamp, roomId: office }, maya);
    const tablet = sharedClient(core);
    const saved = (
      await call(core, tablet.token, "moods.moods", { roomId: office })
    ).json()[0];
    const renamed = await call(core, tablet.token, "moods.updateMood", {
      id: saved.id,
      name: "Quiet",
    });
    const scheduled = await call(core, tablet.token, "moods.scheduleMood", {
      roomId: office,
      moodId: saved.id,
      start: 0,
      end: 1440,
    });

    expect(saved.lights).toEqual([
      { device: lamp, capability: "light", state: { on: true } },
    ]);
    expect(renamed.json()).toMatchObject({
      name: "Quiet",
      lights: saved.lights,
    });
    expect(scheduled.statusCode).toBe(200);
    const entities = (await get(core, "/api/entities", tablet)).json();
    expect(
      entities.find((entity: { key: string }) => entity.key === saved.id),
    ).toMatchObject({ name: "Quiet" });
    expect(
      entities.find(
        (entity: { type: string }) => entity.type === "lights.turnOn",
      ),
    ).toMatchObject({
      state: {
        lights: [{ device: lamp, capability: "light", state: { on: true } }],
      },
    });
  });

  it("has a room's moods counted before the room is removed", async () => {
    const { core, maya, office } = await home();

    const removal = await get(
      core,
      `/api/places/rooms/removal?id=${office}`,
      maya,
    );

    expect(removal.json().entities).toEqual([
      { app: "sanctum.moods", type: "moods.mood", title: "Mood", count: 1 },
    ]);
  });

  it("deletes a room's moods when the room is deleted", async () => {
    const { core, maya, office, kitchen, moodRooms } = await home();

    await post(core, "/api/places/rooms/remove", { id: office }, maya);

    await expect.poll(moodRooms).toEqual([kitchen]);
  });

  it("deletes the moods of a room deleted while it was stopped once it starts", async () => {
    const { core, maya, office, kitchen, moodRooms } = await home();
    await core.apps.remove(moods.id);
    await post(core, "/api/places/rooms/remove", { id: office }, maya);

    const next = await testCore({
      dataDir: core.dataDir,
      apps: [moodsPackage],
    });

    expect(await moodRooms(next)).toEqual([kitchen]);
  });

  it("turns a room back on as it was when it went dark, through its lights.turnOn", async () => {
    const { core, maya, office, lamp } = await home();
    await radio.add("desk-1", "light", "Desk");
    const desk = (await get(core, "/api/devices", maya))
      .json()
      .find((device: { driverName: string }) => device.driverName === "Desk")
      .id as string;
    for (const id of [lamp, desk]) {
      await post(core, "/api/devices/update", { id, roomId: office }, maya);
    }
    await radio.press("lamp-1", { on: true });
    await settled();
    const lights = (to: string) =>
      post(
        core,
        "/api/devices/lights",
        { place: { kind: "room", id: office }, to },
        maya,
      );

    await lights("off");
    await settled();
    await expect
      .poll(async () =>
        (await get(core, "/api/entities?type=lights.turnOn", maya)).json(),
      )
      .toHaveLength(1);
    radio.received.length = 0;
    const on = await lights("on");

    expect(on.json()).toEqual({ on: true, switched: 1, failed: [] });
    expect(radio.received.map(({ command }) => command.key)).toEqual([
      "lamp-1",
    ]);
  });
});
