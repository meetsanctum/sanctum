import { describe, expect, it, vi } from "vitest";

import {
  devicesSeenBy,
  lampsCore,
  openLive,
  personWithClient,
} from "./devices-support.js";
import {
  claimed,
  get,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// Places: every client arranges the home and reads it, shared ones too.

async function home() {
  const core = await testCore();
  const maya = await claimed(core);
  const add = async (kind: string, body: object) =>
    (await post(core, `/api/places/${kind}/add`, body, maya)).json();
  return { core, maya, add };
}

function entries(core: TestCore) {
  return core.activity.recent().filter((entry) => entry.source === "places");
}

describe("places", () => {
  it("start as a home with nothing in it", async () => {
    const { core, maya } = await home();

    expect((await get(core, "/api/places", maya)).json()).toEqual({
      home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
      floors: [],
      rooms: [],
      zones: [],
    });
  });

  it("are arranged from a client: floors, rooms on them, and zones of rooms", async () => {
    const { core, maya, add } = await home();

    await post(
      core,
      "/api/places/home/update",
      { name: "Linden Street" },
      maya,
    );
    const upstairs = await add("floors", { name: "Upstairs", level: 1 });
    const ground = await add("floors", { name: "Ground floor" });
    const bedroom = await add("rooms", {
      name: "Bedroom",
      floorId: upstairs.id,
    });
    const kitchen = await add("rooms", { name: "Kitchen", floorId: ground.id });
    const hall = await add("rooms", { name: "hall" });
    const quiet = await add("zones", {
      name: "Quiet",
      roomIds: [bedroom.id, bedroom.id],
    });

    expect((await get(core, "/api/places", maya)).json()).toEqual({
      home: {
        name: "Linden Street",
        timeZone: "UTC",
        temperatureUnit: "celsius",
      },
      floors: [
        { id: ground.id, name: "Ground floor", level: 0 },
        { id: upstairs.id, name: "Upstairs", level: 1 },
      ],
      rooms: [
        { id: bedroom.id, name: "Bedroom", floorId: upstairs.id },
        { id: hall.id, name: "hall", floorId: null },
        { id: kitchen.id, name: "Kitchen", floorId: ground.id },
      ],
      zones: [{ id: quiet.id, name: "Quiet", roomIds: [bedroom.id] }],
    });
    expect(
      entries(core)
        .map((entry) => entry.action)
        .sort(),
    ).toEqual([
      "floor.add",
      "floor.add",
      "home.update",
      "room.add",
      "room.add",
      "room.add",
      "zone.add",
    ]);
    expect(entries(core)[0]).toMatchObject({
      personId: maya.person.id,
      clientId: maya.client.id,
    });
  });

  it("change and go, keeping what was in them", async () => {
    const { core, maya, add } = await home();
    const upstairs = await add("floors", { name: "Upstairs", level: 1 });
    const bedroom = await add("rooms", {
      name: "Bedroom",
      floorId: upstairs.id,
    });
    const office = await add("rooms", { name: "Office" });
    const quiet = await add("zones", { name: "Quiet", roomIds: [bedroom.id] });

    const renamed = await post(
      core,
      "/api/places/rooms/update",
      { id: office.id, name: "Study", floorId: upstairs.id },
      maya,
    );
    const regrouped = await post(
      core,
      "/api/places/zones/update",
      { id: quiet.id, roomIds: [bedroom.id, office.id] },
      maya,
    );
    expect(renamed.json()).toEqual({
      id: office.id,
      name: "Study",
      floorId: upstairs.id,
    });
    expect(regrouped.json().roomIds).toEqual([bedroom.id, office.id]);

    // Its rooms stay, on no floor; a room leaves its zones.
    await post(core, "/api/places/floors/remove", { id: upstairs.id }, maya);
    const gone = await post(
      core,
      "/api/places/rooms/remove",
      { id: bedroom.id },
      maya,
    );

    expect(gone.statusCode).toBe(204);
    expect((await get(core, "/api/places", maya)).json()).toMatchObject({
      floors: [],
      rooms: [{ id: office.id, name: "Study", floorId: null }],
      zones: [{ id: quiet.id, roomIds: [office.id] }],
    });
  });

  it("leave a removed room's devices in no room", async () => {
    const { core, maya, lamp } = await lampsCore();
    const kitchen = (
      await post(core, "/api/places/rooms/add", { name: "Kitchen" }, maya)
    ).json();
    await post(
      core,
      "/api/devices/update",
      { id: lamp, roomId: kitchen.id },
      maya,
    );
    const mine = await openLive(core, maya.token);
    const shared = await openLive(core, sharedClient(core).token);

    await post(core, "/api/places/rooms/remove", { id: kitchen.id }, maya);

    const light = (await devicesSeenBy(core, maya.token)).find(
      (device: { id: string }) => device.id === lamp,
    );
    expect(light.roomId).toBeNull();
    // Messages arrive over the socket after the request has answered.
    for (const live of [mine, shared]) {
      await vi.waitFor(() =>
        expect(live.messages).toContainEqual({
          type: "device",
          id: lamp,
          device: expect.objectContaining({ id: lamp, roomId: null }),
        }),
      );
      live.socket.terminate();
    }
  });

  it("refuse what does not exist and what is malformed", async () => {
    const { core, maya, add } = await home();
    const room = await add("rooms", { name: "Bedroom" });

    for (const [url, body, status] of [
      ["/api/places/rooms/add", { name: "Attic", floorId: "nowhere" }, 404],
      ["/api/places/zones/add", { name: "Quiet", roomIds: ["nowhere"] }, 404],
      ["/api/places/rooms/update", { id: "nowhere", name: "Den" }, 404],
      ["/api/places/floors/remove", { id: "nowhere" }, 404],
      ["/api/places/rooms/update", { id: room.id, name: " " }, 400],
      ["/api/places/floors/add", { name: "Roof", level: 1.5 }, 400],
    ] as const) {
      expect((await post(core, url, body, maya)).statusCode).toBe(status);
    }
  });

  it("are read and changed by every client, shared ones too", async () => {
    const { core, add } = await home();
    await add("rooms", { name: "Kitchen" });
    const ben = personWithClient(core);
    const kitchen = sharedClient(core);

    const read = await get(core, "/api/places", { token: kitchen.token });
    const byBen = await post(
      core,
      "/api/places/rooms/add",
      { name: "Den" },
      { token: ben.token },
    );
    const byShared = await post(
      core,
      "/api/places/rooms/add",
      { name: "Hall" },
      { token: kitchen.token },
    );
    const anonymous = await get(core, "/api/places");

    expect(read.json().rooms).toHaveLength(1);
    expect(byBen.json()).toMatchObject({ name: "Den" });
    expect(byShared.json()).toMatchObject({ name: "Hall" });
    expect(anonymous.statusCode).toBe(401);
  });

  it("are followed by live clients", async () => {
    const { core, add } = await home();
    const kitchen = sharedClient(core);
    const live = await openLive(core, kitchen.token);

    await add("rooms", { name: "Kitchen" });

    // Messages arrive over the socket after the request has answered.
    await vi.waitFor(() =>
      expect(live.messages).toEqual([
        {
          type: "places",
          places: expect.objectContaining({
            rooms: [expect.objectContaining({ name: "Kitchen" })],
          }),
        },
      ]),
    );
    live.socket.terminate();
  });
});
