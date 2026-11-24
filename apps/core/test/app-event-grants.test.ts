import {
  coreEventNames,
  type CoreEvent,
  type DeviceInfo,
  type Places,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  createEventsForApps,
  type EventsForApps,
} from "../src/app-host/events-for-apps.js";
import { createEventBus } from "../src/event-bus.js";

// The bus as the core sets it, with the events for apps its only follower.
function busFor(events: EventsForApps) {
  const bus = createEventBus({ log: () => undefined });
  bus.setFollowers([["events for apps", events.follower]]);
  return bus;
}

const places: Places = {
  home: {
    name: "Home",
    timeZone: "UTC",
    temperatureUnit: "celsius",
    hourCycle: "24h",
  },
  floors: [],
  rooms: [],
  zones: [],
};
const withRoom: Places = {
  ...places,
  rooms: [{ id: "office", name: "Office", floorId: null }],
};
const device: DeviceInfo = {
  id: "remote",
  name: "Remote",
  driver: "test.driver",
  driverName: "Remote",
  type: "button",
  manufacturer: null,
  model: null,
  roomId: null,
  availability: "online",
  lastSeenAt: null,
  firmware: null,
  probe: false,
  identify: false,
  battery: null,
  batteryLow: null,
  shownAs: null,
  leftAt: null,
  problem: null,
  capabilities: [
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
    {
      id: "switch",
      kind: "switch",
      features: {},
      state: { on: false },
      observed: { on: false },
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    },
  ],
};

function setup(initial: string[], appId = "test.listener") {
  let granted = initial;
  const heard: CoreEvent[] = [];
  const events = createEventsForApps({ timeoutMs: 1000, log() {} });
  const bus = busFor(events);
  const following = events.start(
    appId,
    () => granted,
    () => undefined,
  );
  for (const name of coreEventNames) {
    following.follow(name);
    following.handlers.set(name, [(event) => void heard.push(event)]);
  }
  return {
    events,
    bus,
    following,
    heard,
    grant(next: string[]) {
      const before = granted;
      granted = next;
      events.permissions(appId, before, granted);
    },
    async drain() {
      following.started();
      await expect.poll(() => heard.at(-1)?.name).toBe("permissions.changed");
    },
  };
}

describe("grants when queued events reach an app", () => {
  it("removes an own device's key from both queued snapshots when registration is revoked", async () => {
    const { bus, grant, drain, heard } = setup(
      ["devices.register", "devices.read:switch"],
      device.driver,
    );
    bus.publish({
      name: "device.changed",
      id: device.id,
      key: "own-remote",
      before: device,
      after: { ...device, name: "Renamed" },
    });
    grant(["devices.read:switch"]);
    await drain();

    const event = heard.find((each) => each.name === "device.changed");
    expect(event?.name).toBe("device.changed");
    if (event?.name !== "device.changed") throw new Error("Missing change");
    for (const snapshot of [event.device, event.before]) {
      expect(snapshot).not.toHaveProperty("key");
      expect(snapshot.capabilities.map(({ kind }) => kind)).toEqual(["switch"]);
    }
  });

  it("leaves keys out of new events after registration is revoked", async () => {
    const { bus, grant, drain, heard } = setup(
      ["devices.register", "devices.read:switch"],
      device.driver,
    );
    grant(["devices.read:switch"]);
    await drain();
    bus.publish({
      name: "device.changed",
      id: device.id,
      key: "own-remote",
      before: null,
      after: device,
    });
    await expect.poll(() => heard.at(-1)?.name).toBe("device.added");

    const event = heard.at(-1);
    if (event?.name !== "device.added") throw new Error("Missing addition");
    expect(event.device).not.toHaveProperty("key");
  });

  it("drops queued private data when its permission was revoked", async () => {
    const { bus, grant, drain, heard } = setup([
      "places.read",
      "people.read",
      "entities.read:sun",
      "devices.read:button",
    ]);
    bus.publish({ name: "places.changed", before: places, after: withRoom });
    bus.publish({
      name: "person.changed",
      id: "maya",
      before: null,
      after: {
        id: "maya",
        name: "Maya",
        avatar: null,
        colour: "#8fb5c9",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    bus.publish({
      name: "entity.changed",
      app: "test.sun",
      key: "sun",
      before: null,
      after: {
        app: "test.sun",
        key: "sun",
        type: "sun",
        name: "Sun",
        state: {},
        updatedAt: new Date().toISOString(),
      },
    });
    bus.publish({
      name: "device.changed",
      id: device.id,
      before: null,
      after: device,
    });
    bus.publish({
      name: "device.pressed",
      id: "press",
      device,
      capability: "button",
      action: "single",
      at: new Date(),
      isCaptured: false,
    });
    grant([]);
    await drain();

    expect(heard.map(({ name }) => name)).toEqual(["permissions.changed"]);
  });

  it("filters both device snapshots without inventing a deletion", async () => {
    const { bus, grant, drain, heard } = setup([
      "devices.read:button",
      "devices.read:switch",
    ]);
    bus.publish({
      name: "device.changed",
      id: device.id,
      before: device,
      after: { ...device, name: "Renamed" },
    });
    bus.publish({
      name: "device.pressed",
      id: "press",
      device,
      capability: "button",
      action: "single",
      at: new Date(),
      isCaptured: false,
    });
    grant(["devices.read:switch"]);
    await drain();

    expect(heard.map(({ name }) => name)).toEqual([
      "device.changed",
      "permissions.changed",
    ]);
    const event = heard[0];
    expect(event?.name).toBe("device.changed");
    if (event?.name !== "device.changed") throw new Error("Missing change");
    expect(event.device.capabilities.map(({ kind }) => kind)).toEqual([
      "switch",
    ]);
    expect(event.before.capabilities.map(({ kind }) => kind)).toEqual([
      "switch",
    ]);
  });

  it("checks again between handlers of the same event", async () => {
    const { bus, following, grant, drain, heard } = setup(["places.read"]);
    following.handlers.get("place.added")!.unshift(() => grant([]));
    bus.publish({ name: "places.changed", before: places, after: withRoom });
    await drain();

    expect(heard.map(({ name }) => name)).toEqual(["permissions.changed"]);
  });

  it("drops a device change that affects only a revoked capability", async () => {
    const { bus, grant, drain, heard } = setup([
      "devices.read:button",
      "devices.read:switch",
    ]);
    const after = structuredClone(device);
    after.capabilities = after.capabilities.filter(
      ({ kind }) => kind !== "button",
    );
    bus.publish({
      name: "device.changed",
      id: device.id,
      before: device,
      after,
    });
    grant(["devices.read:switch"]);
    await drain();

    expect(heard.map(({ name }) => name)).toEqual(["permissions.changed"]);
  });

  it("does not widen queued snapshots when another permission is granted", async () => {
    const { bus, grant, drain, heard } = setup(["devices.read:switch"]);
    bus.publish({
      name: "device.changed",
      id: device.id,
      before: null,
      after: device,
    });
    grant(["devices.read:switch", "devices.read:button"]);
    await drain();

    const event = heard[0];
    expect(event?.name).toBe("device.added");
    if (event?.name !== "device.added") throw new Error("Missing addition");
    expect(event.device.capabilities.map(({ kind }) => kind)).toEqual([
      "switch",
    ]);
  });
});
