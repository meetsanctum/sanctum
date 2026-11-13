import type {
  AppInfo,
  CapabilityInfo,
  DeviceInfo,
  EntityInfo,
  LiveMessage,
} from "@meetsanctum/app-sdk";
import { deviceTypeOf } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  createAppClient,
  createLiveFeed,
  type CoreBridge,
} from "../src/client";

// An app's client keeps its pages to what the app was granted, over the
// shell's requests and live socket.

const capability = (id: string, kind: "light" | "switch"): CapabilityInfo =>
  kind === "light"
    ? {
        id,
        kind,
        features: { brightness: true, colorTemperature: null, color: false },
        state: { on: true, brightness: 50 },
        observed: { on: true, brightness: 50 },
        desired: null,
        sync: "synced",
        setBy: null,
        changedAt: null,
      }
    : {
        id,
        kind,
        features: {},
        state: { on: true },
        observed: { on: true },
        desired: null,
        sync: "synced",
        setBy: null,
        changedAt: null,
      };

const device = (id: string, capabilities: CapabilityInfo[]): DeviceInfo => ({
  id,
  name: id,
  driverName: id,
  type: deviceTypeOf(capabilities.map((each) => each.kind)),
  driver: "sanctum.zigbee",
  manufacturer: null,
  model: null,
  roomId: null,
  availability: "online",
  lastSeenAt: null,
  firmware: null,
  probe: false,
  battery: null,
  leftAt: null,
  problem: null,
  capabilities,
});

const lamp = device("lamp", [capability("light", "light")]);
const plug = device("plug", [capability("switch", "switch")]);
const both = device("both", [
  capability("light", "light"),
  capability("switch", "switch"),
]);
// A kind this build has not heard of, as a core newer than it might serve.
const valve = {
  ...capability("valve", "switch"),
  kind: "valve",
} as unknown as CapabilityInfo;
const tap = { ...device("tap", [capability("light", "light")]) };
tap.capabilities = [...tap.capabilities, valve];
const drain = { ...device("drain", []), capabilities: [valve] };
const places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" as const },
  floors: [],
  rooms: [],
  zones: [],
};
const entity = (app: string, key: string, type: string): EntityInfo => ({
  app,
  key,
  type,
  name: key,
  state: {},
  updatedAt: "2026-10-29T10:00:00.000Z",
});
const ownCard = entity("test.lights", "card", "lights.card");
const sun = entity("sanctum.weather", "sun", "sun");
const forecast = entity("sanctum.weather", "forecast", "weather.forecast");

function setup(permissions: string[], requests: AppInfo["requests"] = []) {
  const live = createLiveFeed();
  const json = vi.fn(
    async (path: string, _init?: unknown): Promise<unknown> => {
      if (path === "/api/devices") return [lamp, plug, both];
      if (path === "/api/places") return places;
      if (path === "/api/entities") return [ownCard, sun, forecast];
      if (path === "/api/apps/test.lights/settings") return { dim: true };
      return { ok: true };
    },
  );
  const ask = vi.fn(
    async (_app: string, _permissions: readonly string[]) => true,
  );
  const bridge: CoreBridge = {
    json: json as CoreBridge["json"],
    live,
    ask,
  };
  const app: AppInfo = {
    id: "test.lights",
    name: "Lights",
    version: "0.1.0",
    icon: null,
    pages: [],
    permissions,
    requests,
    state: "running",
    settings: null,
    provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
  };
  return { client: createAppClient(app, bridge), json, live, ask };
}

describe("an app's client", () => {
  it("calls the app's own actions", async () => {
    const { client, json } = setup([]);
    await client.call("lights.switch", { on: true });
    expect(json).toHaveBeenCalledWith(
      "/api/apps/test.lights/actions/lights.switch",
      { method: "POST", json: { on: true }, app: "test.lights" },
    );
  });

  it("names its app on every request, so the core answers with what the app may see", async () => {
    const { client, json } = setup(["places.read", "devices.read:light"]);
    await client.places();
    await client.devices();
    await client.entities();
    await client.settings();
    expect(json.mock.calls.map(([, init]) => init)).toEqual([
      { app: "test.lights" },
      { app: "test.lights" },
      { app: "test.lights" },
      { app: "test.lights" },
    ]);
  });

  it("shows only the capabilities the app may read", async () => {
    const { client } = setup(["devices.read:light"]);
    const devices = await client.devices();
    expect(
      devices.map((each) => [each.id, each.capabilities.map((c) => c.kind)]),
    ).toEqual([
      ["lamp", ["light"]],
      ["both", ["light"]],
    ]);
  });

  it("skips the parts of a kind this build does not know, though the app may read it", async () => {
    const { client, json, live } = setup([
      "devices.read:light",
      "devices.read:valve",
    ]);
    json.mockImplementation(async () => [tap, drain]);
    expect(await client.devices()).toEqual([
      { ...tap, capabilities: [tap.capabilities[0]] },
    ]);

    const messages: LiveMessage[] = [];
    client.subscribe({ message: (message) => messages.push(message) });
    live.publish({ type: "device", id: "tap", device: tap });
    live.publish({ type: "device", id: "drain", device: drain });
    expect(messages).toEqual([
      {
        type: "device",
        id: "tap",
        device: { ...tap, capabilities: [tap.capabilities[0]] },
      },
      { type: "device", id: "drain", device: null },
    ]);
  });

  it("commands only the kinds the app controls, which it may also read", async () => {
    const { client, json } = setup(["devices.control:light"]);
    expect((await client.devices()).map((each) => each.id)).toEqual([
      "lamp",
      "both",
    ]);
    await client.command({
      device: "lamp",
      capability: "light",
      kind: "light",
      command: { brightness: 40 },
    });
    expect(json).toHaveBeenLastCalledWith("/api/devices/command", {
      method: "POST",
      json: {
        device: "lamp",
        capability: "light",
        command: { brightness: 40 },
      },
      app: "test.lights",
    });
    await expect(
      client.command({
        device: "plug",
        capability: "switch",
        kind: "switch",
        command: { on: false },
      }),
    ).rejects.toThrow("test.lights does not hold devices.control:switch");
  });

  it("reads places only with places.read, and devices only with a device permission", async () => {
    const { client } = setup([]);
    await expect(client.places()).rejects.toThrow(/places.read/);
    await expect(client.devices()).rejects.toThrow(/devices.read/);
    expect(await setup(["places.read"]).client.places()).toEqual(places);
  });

  it("follows the shell's live socket, limited the same way", () => {
    const { client, live } = setup(["devices.read:switch"]);
    const messages: LiveMessage[] = [];
    const refresh = vi.fn();
    const stop = client.subscribe({
      message: (message) => messages.push(message),
      refresh,
    });

    live.publish({ type: "device", id: "both", device: both });
    live.publish({ type: "device", id: "lamp", device: lamp });
    live.publish({ type: "places", places });
    // Adding devices and the home's dashboards are the shell's.
    live.publish({ type: "pairing", pairing: { until: null, joined: [] } });
    live.publish({
      type: "dashboards",
      dashboards: [
        {
          id: "home",
          name: "Home",
          background: "mocha",
          kind: "home",
          devices: [],
        },
      ],
    });
    live.refresh();
    stop();
    live.publish({ type: "device", id: "plug", device: plug });

    expect(messages).toEqual([
      {
        type: "device",
        id: "both",
        device: { ...both, capabilities: [both.capabilities[1]] },
      },
      // The app may see nothing of it, as if it had gone.
      { type: "device", id: "lamp", device: null },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("hands on presses, and captures them, only for an app that may read buttons", async () => {
    const press: LiveMessage = {
      type: "press",
      device: "remote",
      capability: "button",
      action: "single",
      at: "2026-10-29T10:00:00.000Z",
      isCaptured: false,
    };
    for (const [permissions, heard] of [
      [["devices.read:button"], [press]],
      [["devices.read:light"], []],
    ] as const) {
      const { client, live } = setup([...permissions]);
      const messages: LiveMessage[] = [];
      client.subscribe({ message: (message) => messages.push(message) });
      live.publish(press);
      expect(messages).toEqual(heard);
    }
    expect(() =>
      setup(["devices.read:light"]).client.capturePresses("remote", {
        press: vi.fn(),
      }),
    ).toThrow("test.lights does not hold devices.read:button");
    // The capture is the app's, so it ends when the app may no longer read
    // buttons.
    const { client, json } = setup(["devices.read:button"]);
    client.capturePresses("remote", { press: vi.fn() });
    expect(json).toHaveBeenCalledWith("/api/devices/capture/start", {
      method: "POST",
      json: { device: "remote", app: "test.lights" },
      app: "test.lights",
    });
  });

  it("reads its own entities, and others' by the standard types it reads", async () => {
    expect(await setup([]).client.entities()).toEqual([ownCard]);
    expect(await setup(["entities.read:sun"]).client.entities()).toEqual([
      ownCard,
      sun,
    ]);
  });

  it("never grants access to another app's private type", async () => {
    const { client, live, json } = setup(["entities.read:other.private"]);
    const privateEntity = entity("test.other", "secret", "other.private");
    json.mockResolvedValueOnce([ownCard, privateEntity]);
    expect(await client.entities()).toEqual([ownCard]);
    const messages: LiveMessage[] = [];
    client.subscribe({ message: (message) => messages.push(message) });
    live.publish({
      type: "entity",
      app: privateEntity.app,
      key: privateEntity.key,
      entity: privateEntity,
      was: null,
    });
    live.publish({
      type: "entity",
      app: privateEntity.app,
      key: privateEntity.key,
      entity: null,
      was: privateEntity.type,
    });
    expect(messages).toEqual([]);
  });

  it("follows entities live, limited the same way", () => {
    const { client, live } = setup(["entities.read:sun"]);
    const messages: LiveMessage[] = [];
    client.subscribe({ message: (message) => messages.push(message) });

    const changed = (each: EntityInfo) =>
      live.publish({
        type: "entity",
        app: each.app,
        key: each.key,
        entity: each,
        was: each.type,
      });
    const gone = (each: EntityInfo) =>
      live.publish({
        type: "entity",
        app: each.app,
        key: each.key,
        entity: null,
        was: each.type,
      });
    changed(ownCard);
    changed(sun);
    changed(forecast);
    gone(forecast);
    gone(sun);

    // Nothing about the forecast, which it does not read.
    expect(
      messages.map(
        (message) =>
          message.type === "entity" && [message.key, !!message.entity],
      ),
    ).toEqual([
      ["card", true],
      ["sun", true],
      ["sun", false],
    ]);
    const { client: alone, live: aloneLive } = setup([]);
    const none: LiveMessage[] = [];
    alone.subscribe({ message: (message) => none.push(message) });
    aloneLive.publish({
      type: "entity",
      app: "sanctum.weather",
      key: "sun",
      entity: null,
      was: "sun",
    });
    expect(none).toEqual([]);
  });

  it("removes a previously readable entity when its key changes type", () => {
    const { client, live } = setup(["entities.read:sun"]);
    const messages: LiveMessage[] = [];
    client.subscribe({ message: (message) => messages.push(message) });
    live.publish({
      type: "entity",
      app: sun.app,
      key: sun.key,
      entity: sun,
      was: null,
    });
    live.publish({
      type: "entity",
      app: sun.app,
      key: sun.key,
      entity: { ...sun, type: "weather.forecast" },
      was: "sun",
    });
    expect(messages.at(-1)).toEqual({
      type: "entity",
      app: sun.app,
      key: sun.key,
      entity: null,
      was: "sun",
    });
  });

  it("never names a type it was before that the app may not read", () => {
    const { client, live } = setup(["entities.read:sun"]);
    const messages: LiveMessage[] = [];
    client.subscribe({ message: (message) => messages.push(message) });
    live.publish({
      type: "entity",
      app: sun.app,
      key: sun.key,
      entity: sun,
      was: "other.private",
    });
    expect(messages).toEqual([
      { type: "entity", app: sun.app, key: sun.key, entity: sun, was: null },
    ]);
  });

  it("asks the shell only for optional permissions that are off, and only for those its manifest lists", async () => {
    const request = (id: string, needed = false) => ({
      id,
      reason: "For the test.",
      needed,
      asked: null,
      startsOn: false,
    });
    const { client, ask } = setup(
      ["devices.control:light", "devices.read:button"],
      [
        request("devices.control:light", true),
        request("devices.read:button"),
        request("places.read"),
        request("devices.read:occupancy"),
        request("workflows.manage"),
      ],
    );

    // What is on already needs no sheet.
    expect(await client.ask("devices.read:button")).toBe(true);
    expect(ask).not.toHaveBeenCalled();

    await expect(client.places()).rejects.toThrow(/does not hold places.read/);
    expect(
      await client.ask([
        "devices.read:button",
        "places.read",
        "workflows.manage",
      ]),
    ).toBe(true);
    expect(ask).toHaveBeenCalledWith("test.lights", [
      "places.read",
      "workflows.manage",
    ]);
    // What it was granted, the client that asked can use at once, and it
    // asks for it no more.
    expect(await client.places()).toEqual(places);
    expect(await client.ask("workflows.manage")).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);

    // Not now is not remembered: the next use asks again.
    ask.mockResolvedValueOnce(false);
    expect(await client.ask("devices.read:occupancy")).toBe(false);
    expect(await client.ask("devices.read:occupancy")).toBe(true);
    expect(ask).toHaveBeenCalledTimes(3);

    // One it needs is granted, never asked; one it doesn't list, never.
    await expect(client.ask("devices.control:light")).rejects.toThrow(
      /never asked/,
    );
    await expect(client.ask("people.read")).rejects.toThrow(
      /does not ask for people.read/,
    );
  });

  it("reads its own settings, and follows them live", async () => {
    const { client, live } = setup([]);
    const messages: LiveMessage[] = [];
    client.subscribe({ message: (message) => messages.push(message) });

    live.publish({ type: "settings", app: "test.lights", settings: {} });
    live.publish({ type: "settings", app: "sanctum.weather", settings: {} });

    expect(await client.settings()).toEqual({ dim: true });
    // Another app's settings never reach it.
    expect(messages).toEqual([
      { type: "settings", app: "test.lights", settings: {} },
    ]);
  });
});

describe("the shell's live feed", () => {
  it("hands every listener a device with the parts this build knows", () => {
    const live = createLiveFeed();
    const messages: LiveMessage[] = [];
    live.subscribe({ message: (message) => messages.push(message) });

    live.publish({ type: "device", id: "tap", device: tap });
    live.publish({ type: "device", id: "drain", device: drain });
    live.publish({ type: "device", id: "lamp", device: lamp });
    live.publish({ type: "device", id: "gone", device: null });

    expect(messages).toEqual([
      {
        type: "device",
        id: "tap",
        device: { ...tap, capabilities: [tap.capabilities[0]] },
      },
      // Nothing of it is known here: a device this build cannot use.
      { type: "device", id: "drain", device: { ...drain, capabilities: [] } },
      { type: "device", id: "lamp", device: lamp },
      { type: "device", id: "gone", device: null },
    ]);
  });
});
