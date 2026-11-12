import {
  defineAction,
  defineApp,
  forecastType,
  sunType,
  type CoreEvent,
  type CoreEventHandler,
  type CoreEventName,
  type Place,
  type Places,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createCoreEvents } from "../src/app-host/core-events.js";
import type { AppPackage } from "../src/app-host/host.js";
import { lampsCore, personWithClient, settled } from "./devices-support.js";
import { claimed, post, testCore } from "./support.js";

// The core's events for apps: a running app follows what happens to devices,
// places, people and the standard entities from its start context, each event
// filtered as the matching read is, and hears nothing once it stops.

// An app that follows the core's events from its start hook and keeps
// what reaches it, without the start time's own.
function listener(
  id: string,
  permissions: string[],
  names: readonly CoreEventName[],
  handle?: (event: CoreEvent) => Promise<void>,
) {
  const heard: CoreEvent[] = [];
  const app = defineApp({
    id,
    name: "Listener",
    version: "0.1.0",
    core: "^1.0.0",
    permissions: permissions.map((id) => ({ id, reason: "For the test." })),
    actions: [],
    events: [],
    async start(ctx) {
      for (const name of names) {
        await ctx.events.on(name, async (event) => {
          heard.push(event);
          await handle?.(event);
        });
      }
    },
  });
  return { pkg: { app, origin: "system" } satisfies AppPackage, heard };
}

const named = (heard: readonly CoreEvent[]) => heard.map(({ name }) => name);

const sunState = {
  date: "2026-10-29",
  timeZone: "Europe/Zurich",
  days: [
    {
      date: "2026-10-29",
      sunrise: "2026-10-29T06:18:00.000Z",
      sunset: "2026-10-29T16:12:00.000Z",
      solarNoon: "2026-10-29T11:15:00.000Z",
    },
  ],
};

describe("the core's events", () => {
  it("show a device with the capabilities each app may read, and nothing to an app that reads none of them", async () => {
    const lights = listener(
      "test.lights",
      ["devices.read:light"],
      ["device.changed"],
    );
    const switches = listener(
      "test.switches",
      ["devices.control:switch"],
      ["device.changed"],
    );
    const { core, maya, lamp, plug } = await lampsCore({
      apps: [lights.pkg, switches.pkg],
    });
    await settled();
    lights.heard.length = 0;
    switches.heard.length = 0;

    await post(
      core,
      "/api/devices/command",
      { device: lamp, capability: "light", command: { on: true } },
      maya,
    );
    await settled();
    await post(core, "/api/places/rooms/add", { name: "Hall" }, maya);
    const room = core.places.list().rooms[0]!.id;
    await post(core, "/api/devices/update", { id: plug, roomId: room }, maya);
    await settled();

    // The lamp's command goes pending, then its report confirms it.
    expect(lights.heard.map((event) => event.name)).toEqual([
      "device.changed",
      "device.changed",
    ]);
    const [pending, confirmed] = lights.heard as Extract<
      CoreEvent,
      { name: "device.changed" }
    >[];
    expect(pending!.device.capabilities).toMatchObject([
      { kind: "light", sync: "pending" },
    ]);
    expect(confirmed!.before.capabilities).toMatchObject([{ sync: "pending" }]);
    expect(confirmed!.device.capabilities).toMatchObject([
      { kind: "light", sync: "synced", observed: { on: true } },
    ]);
    // The plug moved to the hall, and only the app that reads switches
    // heard of it.
    expect(switches.heard).toMatchObject([
      {
        name: "device.changed",
        before: { id: plug, roomId: null },
        device: { id: plug, roomId: room, name: "Hall plug" },
      },
    ]);
    expect(
      switches.heard.flatMap((event) =>
        "device" in event ? event.device.capabilities : [],
      ),
    ).toMatchObject([{ kind: "switch" }]);
  });

  it("follow a room from added to deleted, its zone and its devices with it", async () => {
    const places = listener(
      "test.places",
      ["places.read", "devices.read:light"],
      [
        "place.added",
        "place.changed",
        "place.deleted",
        "device.changed",
        "device.deleted",
      ],
    );
    const { core, maya, lamp } = await lampsCore({ apps: [places.pkg] });
    await settled();
    places.heard.length = 0;

    const room = (
      await post(core, "/api/places/rooms/add", { name: "Office" }, maya)
    ).json();
    await post(
      core,
      "/api/devices/update",
      { id: lamp, roomId: room.id },
      maya,
    );
    const zone = (
      await post(
        core,
        "/api/places/zones/add",
        { name: "Upstairs", roomIds: [room.id] },
        maya,
      )
    ).json();
    // The zone came last, so the app has heard all before it.
    await expect
      .poll(() => places.heard.at(-1))
      .toMatchObject({ name: "place.added", place: { id: zone.id } });
    places.heard.length = 0;
    await post(core, "/api/places/rooms/remove", { id: room.id }, maya);

    // Its devices move to no room first, then follow its name to none.
    await expect
      .poll(() => places.heard)
      .toMatchObject([
        {
          name: "device.changed",
          before: { id: lamp, roomId: room.id, name: "Office light" },
          device: { id: lamp, roomId: null, name: "Office light" },
        },
        { name: "place.deleted", place: { kind: "room", id: room.id } },
        {
          name: "place.changed",
          before: { kind: "zone", id: zone.id, roomIds: [room.id] },
          place: { kind: "zone", id: zone.id, roomIds: [] },
        },
        {
          name: "device.changed",
          before: { id: lamp, roomId: null, name: "Office light" },
          device: { id: lamp, roomId: null, name: "Light" },
        },
      ]);
  });

  it("follow where the home is, apart from its name and its rooms", async () => {
    const located = listener(
      "test.located",
      ["places.location"],
      ["location.changed"],
    );
    const named = listener("test.named", ["places.read"], ["place.changed"]);
    const { core, maya } = await lampsCore({
      apps: [located.pkg, named.pkg],
    });
    await settled();
    const zurich = { latitude: 47.3769, longitude: 8.5417, elevation: null };
    const update = (changes: object) =>
      post(core, "/api/places/home/update", changes, maya);

    await update({ timeZone: "Europe/Zurich", coordinates: zurich });
    await settled();
    expect(located.heard).toEqual([
      {
        name: "location.changed",
        before: null,
        location: { ...zurich, timeZone: "Europe/Zurich" },
      },
    ]);
    located.heard.length = 0;

    await update({ name: "The house" });
    await settled();
    expect(located.heard).toEqual([]);
    expect(named.heard).toMatchObject([
      { name: "place.changed", place: { kind: "home", name: "The house" } },
    ]);
    expect(JSON.stringify(named.heard)).not.toContain("latitude");

    await update({ coordinates: null });
    await settled();
    expect(located.heard).toEqual([
      {
        name: "location.changed",
        before: { ...zurich, timeZone: "Europe/Zurich" },
        location: null,
      },
    ]);
  });

  it("follow the household, the claimant included, and nothing a rolled-back change made", async () => {
    const people = listener(
      "test.people",
      ["people.read"],
      ["person.added", "person.changed", "person.deleted"],
    );
    const core = await testCore({ apps: [people.pkg] });
    const maya = await claimed(core);
    const ben = personWithClient(core, "Ben").person;
    core.people.update(ben.id, { name: "Benjamin" });
    core.people.remove(ben.id);
    expect(() =>
      core.db.transaction(() => {
        core.people.add({ name: "Nobody", colour: "#8fb5c9" });
        throw new Error("rolled back");
      }),
    ).toThrow("rolled back");

    await expect
      .poll(() => people.heard)
      .toEqual([
        {
          name: "person.added",
          person: {
            id: maya.person.id,
            name: maya.person.name,
            avatar: null,
            colour: expect.any(String),
          },
        },
        {
          name: "person.added",
          person: expect.objectContaining({ id: ben.id, name: "Ben" }),
        },
        {
          name: "person.changed",
          before: expect.objectContaining({ name: "Ben" }),
          person: expect.objectContaining({ name: "Benjamin" }),
        },
        {
          name: "person.deleted",
          person: expect.objectContaining({ id: ben.id, name: "Benjamin" }),
        },
      ]);
  });

  it("never announce intermediate people from a rolled-back transaction", async () => {
    const people = listener(
      "test.people",
      ["people.read"],
      ["person.added", "person.changed", "person.deleted"],
    );
    const core = await testCore({ apps: [people.pkg] });
    expect(() =>
      core.db.transaction(() => {
        const person = core.people.add({
          name: "Nobody",
          colour: "#8fb5c9",
        });
        core.people.update(person.id, { name: "Still nobody" });
        throw new Error("rolled back");
      }),
    ).toThrow("rolled back");
    await settled();
    expect(people.heard).toEqual([]);
  });

  it("announce a committed person before a subsequent synchronous change", async () => {
    const people = listener(
      "test.people",
      ["people.read"],
      ["person.added", "person.changed", "person.deleted"],
    );
    const core = await testCore({ apps: [people.pkg] });
    const person = core.db.transaction(() =>
      core.people.add({ name: "Ben", colour: "#8fb5c9" }),
    );
    core.people.update(person.id, { name: "Benjamin" });
    await expect
      .poll(() => people.heard)
      .toMatchObject([
        { name: "person.added", person: { name: "Ben" } },
        {
          name: "person.changed",
          before: { name: "Ben" },
          person: { name: "Benjamin" },
        },
      ]);
  });

  it("show only the standard types each app may read, whichever app provides them", async () => {
    const sun = listener(
      "test.sun",
      [`entities.read:${sunType.id}`],
      ["entity.added", "entity.changed", "entity.deleted"],
    );
    const core = await testCore({ apps: [sun.pkg] });
    const entity = { type: sunType.id, key: "home", name: "Sun" };

    core.entities.publish("test.sky", { ...entity, state: sunState });
    core.entities.publish("test.sky", {
      type: forecastType.id,
      key: "forecast",
      name: "Forecast",
      state: {},
    });
    core.entities.publish("test.sky", {
      ...entity,
      state: { ...sunState, date: "2026-10-30" },
    });
    // The same key, now of a type the app may not read.
    core.entities.publish("test.sky", {
      ...entity,
      type: forecastType.id,
      state: {},
    });

    await expect
      .poll(() => sun.heard)
      .toMatchObject([
        { name: "entity.added", entity: { app: "test.sky", key: "home" } },
        {
          name: "entity.changed",
          before: { state: { date: "2026-10-29" } },
          entity: { state: { date: "2026-10-30" } },
        },
        { name: "entity.deleted", entity: { type: sunType.id, key: "home" } },
      ]);
  });

  it.each([
    ["device.changed", [], "holds no devices.read: permission"],
    [
      "device.pressed",
      ["devices.read:light"],
      "does not hold devices.read:button",
    ],
    ["place.deleted", ["devices.read:light"], "does not hold places.read"],
    ["location.changed", ["places.read"], "does not hold places.location"],
    ["person.added", ["places.read"], "does not hold people.read"],
    [
      "entity.added",
      ["entities.read:test.own"],
      "holds no entities.read: permission for a standard type",
    ],
  ] as const)(
    "cannot follow %s without the permission to read it",
    async (name, permissions, refusal) => {
      const blind = listener("test.blind", [...permissions], [name]);
      const core = await testCore({ apps: [blind.pkg] });

      expect(core.logs).toContain(
        `apps: test.blind did not start (test.blind ${refusal}, which ${name} needs)`,
      );
    },
  );

  it("are the core's own, never another app's", async () => {
    const core = await testCore({
      apps: [
        {
          origin: "system",
          app: defineApp({
            id: "test.eager",
            name: "Eager",
            version: "0.1.0",
            core: "^1.0.0",
            permissions: [{ id: "places.read", reason: "For the test." }],
            actions: [],
            events: [],
            async start(ctx) {
              await ctx.events.on(
                "example.itemAdded" as CoreEventName,
                () => {},
              );
            },
          }),
        },
      ],
    });

    expect(core.logs).toContain(
      "apps: test.eager did not start (example.itemAdded is not one of the core's events)",
    );
  });

  it("are followed from the start context, never an action's", async () => {
    const core = await testCore({
      apps: [
        {
          origin: "system",
          app: defineApp({
            id: "test.late",
            name: "Late",
            version: "0.1.0",
            core: "^1.0.0",
            permissions: [{ id: "places.read", reason: "For the test." }],
            actions: [
              defineAction({
                id: "late.follow",
                title: "Follow",
                tier: "read",
                input: z.object({}),
                output: z.object({}),
                async run(ctx) {
                  await ctx.events.on("place.added", () => {});
                  return {};
                },
              }),
            ],
            events: [],
          }),
        },
      ],
    });
    const maya = await claimed(core);

    const followed = await post(
      core,
      "/api/apps/test.late/actions/late.follow",
      {},
      maya,
    );

    expect(followed.statusCode).toBe(500);
    expect(core.logs).toContain(
      "apps: late.follow failed (Only the start hook's context follows events)",
    );
  });

  it.each(["fails", "times out"])(
    "reach nothing of an app in the core's process whose start %s, and leave its actions be",
    async (outcome) => {
      const heard: CoreEvent[] = [];
      // Apart, its container ends and it starts again.
      const core = await testCore({
        appTimeoutMs: 50,
        inProcess: [
          {
            origin: "system",
            app: defineApp({
              id: "test.halfway",
              name: "Halfway",
              version: "0.1.0",
              core: "^1.0.0",
              permissions: [{ id: "places.read", reason: "For the test." }],
              actions: [
                defineAction({
                  id: "halfway.rooms",
                  title: "Rooms",
                  tier: "read",
                  input: z.object({}),
                  output: z.number(),
                  async run(ctx) {
                    return (await ctx.places.list()).rooms.length;
                  },
                }),
              ],
              events: [],
              async start(ctx) {
                await ctx.events.on("place.added", (event) => {
                  heard.push(event);
                });
                if (outcome === "fails") throw new Error("no catching up");
                await new Promise(() => {});
              },
            }),
          },
        ],
      });
      const maya = await claimed(core);

      await post(core, "/api/places/rooms/add", { name: "Office" }, maya);
      await settled();
      const rooms = await post(
        core,
        "/api/apps/test.halfway/actions/halfway.rooms",
        {},
        maya,
      );

      expect(core.logs).toContainEqual(
        expect.stringMatching(/^apps: test\.halfway did not start/),
      );
      expect(heard).toEqual([]);
      expect(rooms.json()).toBe(1);
    },
  );

  it("stop with the app, which finishes the one it is handling, and start again with it", async () => {
    let release!: () => void;
    const releases = new Promise<void>((resolve) => (release = resolve));
    const places = listener(
      "test.places",
      ["places.read"],
      ["place.added"],
      () => releases,
    );
    // Only an app that is not a system app can be removed.
    const pkg: AppPackage = { ...places.pkg, origin: "official" };
    const first = await testCore({ apps: [pkg] });
    const maya = await claimed(first);
    await post(first, "/api/places/rooms/add", { name: "Office" }, maya);
    await post(first, "/api/places/rooms/add", { name: "Hall" }, maya);
    await settled();

    // Stopping waits for the office's handler; the hall's never runs.
    let stopped = false;
    const stopping = first.apps
      .remove("test.places")
      .then(() => (stopped = true));
    await settled();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await post(first, "/api/places/rooms/add", { name: "Attic" }, maya);
    await settled();
    expect(places.heard).toMatchObject([
      { name: "place.added", place: { name: "Office" } },
    ]);

    // Started again, it follows anew, once.
    const next = await testCore({ dataDir: first.dataDir, apps: [pkg] });
    await post(next, "/api/places/rooms/add", { name: "Kitchen" }, maya);
    await settled();
    expect(named(places.heard)).toEqual(["place.added", "place.added"]);
    expect(places.heard[1]).toMatchObject({ place: { name: "Kitchen" } });
  });
});

describe("delivering the core's events", () => {
  const before: Places = {
    home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
    floors: [],
    rooms: [],
    zones: [],
  };
  const withRoom = (id: string): Places => ({
    ...before,
    rooms: [{ id, name: id, floorId: null }],
  });
  // A handler for the places added, as ctx.events.on() keeps one.
  const onAdded =
    (handle: (place: Place) => void | Promise<void>): CoreEventHandler =>
    async (event) => {
      if (event.name === "place.added") await handle(event.place);
    };

  it("waits for the start hook to catch up", async () => {
    const events = createCoreEvents({ timeoutMs: 1000, log() {} });
    const following = events.start("test.places", () => ["places.read"]);
    const heard: string[] = [];
    following.handlers.set("place.added", [
      onAdded((place) => void heard.push(place.kind)),
    ]);
    following.follow("place.added");

    events.places(before, withRoom("office"));
    await settled();
    expect(heard).toEqual([]);
    following.started();
    await settled();

    expect(heard).toEqual(["room"]);
  });

  it("logs a handler that fails or takes too long and goes on to the next", async () => {
    const logs: string[] = [];
    const events = createCoreEvents({
      timeoutMs: 20,
      log: (message) => logs.push(message),
    });
    const following = events.start("test.places", () => ["places.read"]);
    const heard: string[] = [];
    following.handlers.set("place.added", [
      onAdded(async (place) => {
        if (place.kind !== "room") return;
        if (place.id === "office") throw new Error("no office");
        if (place.id === "attic") await new Promise(() => {});
        heard.push(place.id);
      }),
    ]);
    following.follow("place.added");
    following.started();

    events.places(before, withRoom("office"));
    events.places(before, withRoom("attic"));
    events.places(before, withRoom("hall"));
    await expect.poll(() => heard).toEqual(["hall"]);

    expect(logs).toEqual([
      "apps: test.places did not handle place.added (no office)",
      "apps: test.places did not handle place.added (timed out)",
    ]);
  });
});
