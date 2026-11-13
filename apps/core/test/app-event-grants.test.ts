import {
  coreEventNames,
  type CoreEvent,
  type DeviceInfo,
  type Places,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { createCoreEvents } from "../src/app-host/core-events.js";

const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
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
  battery: null,
  leftAt: null,
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

function setup(initial: string[]) {
  let granted = initial;
  const heard: CoreEvent[] = [];
  const events = createCoreEvents({ timeoutMs: 1000, log() {} });
  const following = events.start(
    "test.listener",
    () => granted,
    () => undefined,
  );
  for (const name of coreEventNames) {
    following.follow(name);
    following.handlers.set(name, [(event) => void heard.push(event)]);
  }
  return {
    events,
    following,
    heard,
    grant(next: string[]) {
      const before = granted;
      granted = next;
      events.permissions("test.listener", before, granted);
    },
    async drain() {
      following.started();
      await expect.poll(() => heard.at(-1)?.name).toBe("permissions.changed");
    },
  };
}

describe("grants when queued events reach an app", () => {
  it("drops queued private data when its permission was revoked", async () => {
    const { events, grant, drain, heard } = setup([
      "places.read",
      "people.read",
      "entities.read:sun",
      "devices.read:button",
    ]);
    events.places(places, withRoom);
    events.person({
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
    events.entity({
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
    events.device({ id: device.id, before: null, after: device });
    events.pressed({
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
    const { events, grant, drain, heard } = setup([
      "devices.read:button",
      "devices.read:switch",
    ]);
    events.device({
      id: device.id,
      before: device,
      after: { ...device, name: "Renamed" },
    });
    events.pressed({
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
    const { events, following, grant, drain, heard } = setup(["places.read"]);
    following.handlers.get("place.added")!.unshift(() => grant([]));
    events.places(places, withRoom);
    await drain();

    expect(heard.map(({ name }) => name)).toEqual(["permissions.changed"]);
  });

  it("drops a device change that affects only a revoked capability", async () => {
    const { events, grant, drain, heard } = setup([
      "devices.read:button",
      "devices.read:switch",
    ]);
    const after = structuredClone(device);
    after.capabilities = after.capabilities.filter(
      ({ kind }) => kind !== "button",
    );
    events.device({ id: device.id, before: device, after });
    grant(["devices.read:switch"]);
    await drain();

    expect(heard.map(({ name }) => name)).toEqual(["permissions.changed"]);
  });

  it("does not widen queued snapshots when another permission is granted", async () => {
    const { events, grant, drain, heard } = setup(["devices.read:switch"]);
    events.device({ id: device.id, before: null, after: device });
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
