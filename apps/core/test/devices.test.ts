import { defineApp, type AppContext } from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { loadAppPackage } from "./runner-apps.js";
import { createDevices } from "../src/devices/devices.js";
import { deviceCapabilities } from "../src/devices/schema.js";
import {
  command,
  devicesSeenBy,
  lampsCore,
  openLive,
  personWithClient,
  radio,
  settled,
} from "./devices-support.js";
import { fixtureApps, post, sharedClient, type TestCore } from "./support.js";

// Devices and the Drivers contract: a driver app brings devices in, people use
// them through the client routes, and every command goes through the permission
// gate to the driver.

function entries(core: TestCore, action: string) {
  return core.activity.recent().filter((entry) => entry.action === action);
}

describe("a driver app's devices", () => {
  it("are registered and reported when the driver starts", async () => {
    const { core, maya } = await lampsCore();

    expect(await devicesSeenBy(core, maya.token)).toEqual([
      {
        id: expect.any(String),
        // A new device is named after what it is until it is in a room.
        name: "Plug",
        driver: "test.lamps",
        manufacturer: "Test",
        model: "Plug",
        roomId: null,
        driverName: "Kettle plug",
        type: "plug",
        availability: "online",
        lastSeenAt: "2026-10-26T12:00:00.000Z",
        capabilities: [
          {
            id: "power",
            kind: "switch",
            features: {},
            state: { on: false },
            observed: { on: false },
            desired: null,
            sync: "synced",
            setBy: null,
            changedAt: expect.any(String),
          },
        ],
        firmware: {
          version: "1.0.0",
          updatable: false,
          sleeps: false,
          state: null,
          progress: null,
          remainingSeconds: null,
          problem: null,
          checkedAt: null,
          startedAt: null,
          endedAt: null,
        },
        probe: true,
        battery: null,
        leftAt: null,
        problem: null,
      },
      expect.objectContaining({
        name: "Light",
        driverName: "Kitchen lamp",
        type: "light",
        capabilities: [
          expect.objectContaining({
            id: "light",
            kind: "light",
            features: {
              brightness: true,
              colorTemperature: { min: 153, max: 500 },
              color: true,
            },
            state: {
              on: false,
              brightness: 100,
              colorMode: "temperature",
              colorTemperature: 370,
            },
          }),
        ],
      }),
    ]);
    expect(entries(core, "device.register")).toHaveLength(2);
  });

  it("go in a room, are switched, and the driver carries the command out", async () => {
    const { core, maya, lamp } = await lampsCore();
    const kitchen = (
      await post(core, "/api/places/rooms/add", { name: "Kitchen" }, maya)
    ).json();

    const moved = await post(
      core,
      "/api/devices/update",
      { id: lamp, roomId: kitchen.id },
      maya,
    );
    // The lamp says what it did only once the test has seen the answer.
    radio.confirms = false;
    const sent = await command(core, maya.token, lamp, "light", {
      brightness: 60,
    });

    expect(moved.json()).toMatchObject({ id: lamp, roomId: kitchen.id });
    expect(sent.statusCode).toBe(200);
    // Shown at once, until the lamp confirms it.
    expect(sent.json()).toMatchObject({
      sync: "pending",
      desired: { on: true, brightness: 60 },
      state: { on: true, brightness: 60 },
      observed: { on: false, brightness: 100 },
    });
    expect(radio.received).toEqual([
      {
        command: {
          key: "lamp-1",
          device: lamp,
          capability: "light",
          kind: "light",
          command: { on: true, brightness: 60 },
        },
        actor: { kind: "user", id: maya.person.id },
      },
    ]);

    radio.confirms = true;
    await radio.press("lamp-1", {});
    await settled();
    const [, light] = await devicesSeenBy(core, maya.token);
    expect(light.capabilities[0]).toMatchObject({
      sync: "synced",
      desired: null,
      observed: { on: true, brightness: 60 },
    });
    expect(entries(core, "device.command")).toEqual([
      expect.objectContaining({
        source: "devices",
        outcome: "ok",
        personId: maya.person.id,
        clientId: maya.client.id,
        subjectId: lamp,
      }),
    ]);
    expect(entries(core, "device.update")).toHaveLength(1);
  });

  it("end in conflict when the device does not confirm a command in time, even sent again", async () => {
    const { core, maya, plug } = await lampsCore({ confirmMs: 20 });
    radio.confirms = false;

    const sent = await command(core, maya.token, plug, "power", { on: true });
    expect(sent.json()).toMatchObject({ sync: "pending", state: { on: true } });

    // Both deadlines and the send between them run on the real clock, so
    // the test waits for the outcome, however long a slow runner takes.
    const power = async () =>
      (await devicesSeenBy(core, maya.token))[0].capabilities[0];
    await expect.poll(power).toMatchObject({
      sync: "conflict",
      desired: null,
      state: { on: false },
    });
    expect(radio.received.map(({ command }) => command.command)).toEqual([
      { on: true },
      { on: true },
    ]);

    // The next report clears it.
    await radio.press("plug-1", { on: true });
    const [again] = await devicesSeenBy(core, maya.token);
    expect(again.capabilities[0]).toMatchObject({
      sync: "synced",
      state: { on: true },
    });
  });

  it("hold a colour for a light that is off and send it when it turns on", async () => {
    const { core, maya, lamp } = await lampsCore();

    const held = await command(core, maya.token, lamp, "light", {
      colorTemperature: 250,
    });
    expect(held.json()).toMatchObject({
      sync: "held",
      state: { on: false, colorMode: "temperature", colorTemperature: 250 },
    });
    expect(radio.received).toEqual([]);

    await command(core, maya.token, lamp, "light", { on: true });
    expect(radio.received.map(({ command }) => command.command)).toEqual([
      { on: true, brightness: 100, colorTemperature: 250 },
    ]);
    await settled();
    const [, light] = await devicesSeenBy(core, maya.token);
    expect(light.capabilities[0]).toMatchObject({
      sync: "synced",
      observed: { on: true, colorTemperature: 250 },
    });
  });

  it("come back at the brightness they had, whatever they report once off", async () => {
    const { core, maya, lamp } = await lampsCore();
    await command(core, maya.token, lamp, "light", { brightness: 80 });
    await settled();

    // Off, the lamp reports its lowest level, as many lights do.
    await radio.press("lamp-1", { on: false, brightness: 1 });
    const [, off] = await devicesSeenBy(core, maya.token);
    expect(off.capabilities[0]).toMatchObject({
      sync: "synced",
      observed: { on: false, brightness: 80 },
      state: { on: false, brightness: 80 },
    });

    // It is kept in the database, so a restarted core remembers it too.
    const restarted = createDevices(core.db, {
      gate: core.gate,
      places: core.places,
      activity: core.activity,
      deliver: async () => {},
    });
    expect(restarted.get(lamp)?.capabilities[0]).toMatchObject({
      state: { on: false, brightness: 80 },
    });
    restarted.close();

    radio.received.length = 0;
    await command(core, maya.token, lamp, "light", { on: true });
    expect(radio.received.map(({ command }) => command.command)).toEqual([
      { on: true, brightness: 80 },
    ]);
    await settled();
    const [, on] = await devicesSeenBy(core, maya.token);
    expect(on.capabilities[0]).toMatchObject({
      sync: "synced",
      observed: { on: true, brightness: 80 },
    });
  });

  it("go off without turning on and come back at what an off said", async () => {
    const { core, maya, lamp } = await lampsCore();
    await command(core, maya.token, lamp, "light", { brightness: 40 });
    await settled();

    radio.received.length = 0;
    await command(core, maya.token, lamp, "light", {
      on: false,
      brightness: 70,
      colorTemperature: 250,
    });
    expect(radio.received.map(({ command }) => command.command)).toEqual([
      { on: false },
    ]);
    await settled();
    const [, off] = await devicesSeenBy(core, maya.token);
    expect(off.capabilities[0]).toMatchObject({
      sync: "held",
      observed: { on: false, brightness: 40, colorTemperature: 370 },
      state: { on: false, brightness: 70, colorTemperature: 250 },
    });

    radio.received.length = 0;
    await command(core, maya.token, lamp, "light", { on: true });
    expect(radio.received.map(({ command }) => command.command)).toEqual([
      { on: true, brightness: 70, colorTemperature: 250 },
    ]);
  });

  it("come back at 1% when they were set to 1% before going off", async () => {
    const { core, maya, lamp } = await lampsCore();
    await command(core, maya.token, lamp, "light", { brightness: 1 });
    await settled();
    await command(core, maya.token, lamp, "light", { on: false });
    await settled();

    radio.received.length = 0;
    await command(core, maya.token, lamp, "light", { on: true });
    expect(radio.received.map(({ command }) => command.command)).toEqual([
      { on: true, brightness: 1 },
    ]);
  });

  it("go back to what was asked before when the driver fails a command", async () => {
    const { core, maya, plug } = await lampsCore();
    await radio.unplug("plug-1");

    const sent = await command(core, maya.token, plug, "power", { on: true });

    expect(sent.statusCode).toBe(500);
    expect(sent.json()).toEqual({ error: "app_failed" });
    const [kettle] = await devicesSeenBy(core, maya.token);
    expect(kettle).toMatchObject({ availability: "offline" });
    expect(kettle.capabilities[0]).toMatchObject({
      sync: "synced",
      desired: null,
    });
    expect(entries(core, "device.command")).toEqual([
      expect.objectContaining({ outcome: "failed", reason: "app_failed" }),
    ]);
  });

  it("are unavailable while their driver app is not running", async () => {
    const { core, maya, plug } = await lampsCore({ origin: "official" });
    await core.apps.remove("test.lamps");

    const sent = await command(core, maya.token, plug, "power", { on: true });

    expect(sent.statusCode).toBe(503);
    expect(sent.json()).toEqual({ error: "unavailable" });
    expect(radio.stopped).toBe(1);
  });

  it("refuse commands their capability cannot carry out", async () => {
    const { core, maya, lamp, plug } = await lampsCore();

    for (const [device, capability, body] of [
      [lamp, "light", { brightness: 150 }],
      [lamp, "light", { colorTemperature: 900 }],
      [plug, "power", { on: true, brightness: 40 }],
      [lamp, "light", {}],
    ] as const) {
      const sent = await command(core, maya.token, device, capability, body);
      expect(sent.statusCode).toBe(400);
    }
    const missing = await command(core, maya.token, lamp, "power", {
      on: true,
    });
    expect(missing.statusCode).toBe(404);
    expect(radio.received).toEqual([]);
    expect(entries(core, "device.command")).toHaveLength(5);
    expect(
      entries(core, "device.command").every(
        (entry) => entry.outcome === "refused",
      ),
    ).toBe(true);
  });

  it("drops a held colour when the driver removes that feature", async () => {
    const { core, maya, lamp } = await lampsCore();
    await command(core, maya.token, lamp, "light", { colorTemperature: 250 });
    core.devices.register("test.lamps", {
      key: "lamp-1",
      name: "Kitchen lamp",
      capabilities: [{ id: "light", kind: "light" }],
    });
    await command(core, maya.token, lamp, "light", { on: true });
    expect(radio.received[0]!.command.command).toEqual({ on: true });
  });

  it("keep what the household decided when their driver registers them again", async () => {
    const { core, maya, lamp } = await lampsCore();
    const hall = (
      await post(core, "/api/places/rooms/add", { name: "Hall" }, maya)
    ).json();
    await post(
      core,
      "/api/devices/update",
      { id: lamp, name: "Reading lamp", roomId: hall.id },
      maya,
    );

    // As the driver does when it starts again, with what it now knows.
    core.devices.register("test.lamps", {
      key: "lamp-1",
      name: "0x00158d0001",
      capabilities: [
        { id: "light", kind: "light", features: { brightness: true } },
        { id: "power", kind: "switch" },
      ],
    });

    const light = core.devices.get(lamp)!;
    expect(light).toMatchObject({ name: "Reading lamp", roomId: hall.id });
    expect(light.capabilities).toMatchObject([
      {
        id: "light",
        features: { brightness: true, colorTemperature: null },
        observed: { on: false, brightness: 100 },
      },
      { id: "power", kind: "switch", observed: null, state: null },
    ]);

    // Giving the name back names it after its room again.
    const named = await post(
      core,
      "/api/devices/update",
      { id: lamp, name: null },
      maya,
    );
    expect(named.json().name).toBe("Hall light");
  });
});

describe("the Drivers contract", () => {
  // A second driver that holds on to its context, so a test can use it.
  async function withSecondDriver() {
    let ctx: AppContext | undefined;
    const other = defineApp({
      id: "test.other",
      name: "Other",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [{ id: "devices.register", reason: "For the test." }],
      actions: [],
      events: [],
      async start(context) {
        ctx = context;
      },
      driver: { command: async () => {} },
    });
    const home = await lampsCore({ apps: [{ app: other, origin: "system" }] });
    return { ...home, other: () => ctx! };
  }

  it("lets a driver report only its own devices", async () => {
    const { core, maya, other } = await withSecondDriver();

    await expect(
      other().devices.report({
        key: "lamp-1",
        states: { light: { on: true } },
      }),
    ).rejects.toMatchObject({ name: "ActionError", code: "not_found" });

    const [, light] = await devicesSeenBy(core, maya.token);
    expect(light.capabilities[0].observed.on).toBe(false);
  });

  it("keeps the same key from two drivers apart", async () => {
    const { core, maya, lamp, other } = await withSecondDriver();

    const { id } = await other().devices.register({
      key: "lamp-1",
      name: "Hallway light",
      capabilities: [{ id: "light", kind: "light" }],
    });

    expect(id).not.toBe(lamp);
    expect(
      (await devicesSeenBy(core, maya.token)).map(
        (device: { driverName: string; driver: string }) =>
          `${device.driverName} (${device.driver})`,
      ),
    ).toEqual([
      "Hallway light (test.other)",
      "Kettle plug (test.lamps)",
      "Kitchen lamp (test.lamps)",
    ]);
  });

  it("marks a device that left while its driver was not running offline once the driver says what it has", async () => {
    const { core, maya, lamp, plug } = await lampsCore({ origin: "official" });
    await core.apps.remove("test.lamps");
    // The kettle plug was reset meanwhile, so the radio no longer has it.
    radio.gadgets.delete("plug-1");
    const live = await openLive(core, maya.token);

    await core.startApps([
      await loadAppPackage(join(fixtureApps, "lamps"), "official"),
    ]);

    const [kettle, light] = await devicesSeenBy(core, maya.token);
    expect(kettle).toMatchObject({
      id: plug,
      availability: "offline",
      leftAt: "2026-10-26T12:00:00.000Z",
    });
    expect(light).toMatchObject({
      id: lamp,
      availability: "online",
      leftAt: null,
    });
    expect(live.messages).toContainEqual({
      type: "device",
      id: plug,
      device: expect.objectContaining({ availability: "offline" }),
    });
    // The log says it left its network, under the driver that said so.
    expect(entries(core, "device.left")).toEqual([
      expect.objectContaining({
        source: "devices",
        app: "test.lamps",
        subjectId: plug,
      }),
    ]);
  });

  it("forgets that a device left once its network has it again", async () => {
    const { core, maya, other } = await withSecondDriver();
    await other().devices.register({
      key: "fan",
      name: "Fan",
      capabilities: [{ id: "power", kind: "switch" }],
    });
    await other().devices.report({ key: "fan", availability: "online" });

    await other().devices.present({ keys: [] });
    // Saying so again is no news.
    await other().devices.present({ keys: [] });
    const fan = async () =>
      (await devicesSeenBy(core, maya.token)).find(
        (device: { driverName: string }) => device.driverName === "Fan",
      );
    expect(await fan()).toMatchObject({
      availability: "offline",
      leftAt: expect.any(String),
    });
    expect(entries(core, "device.left")).toHaveLength(1);
    // A late report doesn't bring it back while its network hasn't it.
    await other().devices.report({ key: "fan", availability: "online" });
    expect(await fan()).toMatchObject({
      availability: "offline",
      leftAt: expect.any(String),
    });

    await other().devices.present({ keys: ["fan"] });
    expect(await fan()).toMatchObject({ leftAt: null });
    await other().devices.report({ key: "fan", availability: "online" });
    expect(await fan()).toMatchObject({ availability: "online" });

    // Joining again, as itself, says so too.
    await other().devices.present({ keys: [] });
    await other().devices.register({
      key: "fan",
      name: "Fan",
      capabilities: [{ id: "power", kind: "switch" }],
    });
    expect(await fan()).toMatchObject({ leftAt: null });
  });

  it("lets a driver mark only its own devices offline", async () => {
    const { core, maya, other } = await withSecondDriver();
    await other().devices.register({
      key: "fan",
      name: "Fan",
      capabilities: [{ id: "power", kind: "switch" }],
    });
    await other().devices.report({ key: "fan", availability: "online" });

    await other().devices.present({ keys: ["lamp-1"] });

    expect(
      (await devicesSeenBy(core, maya.token)).map(
        (device: { driverName: string; availability: string }) =>
          `${device.driverName}: ${device.availability}`,
      ),
    ).toEqual(["Fan: offline", "Kettle plug: online", "Kitchen lamp: online"]);
    await expect(
      other().devices.present({ keys: "fan" as unknown as string[] }),
    ).rejects.toThrow(/cannot take/);
  });

  it("refuses registrations and reports the core cannot take", async () => {
    const { other } = await withSecondDriver();

    await expect(
      other().devices.register({
        key: "fan",
        name: "Fan",
        capabilities: [{ id: "fan", kind: "fan" as "switch" }],
      }),
    ).rejects.toThrow(/cannot take/);
    await other().devices.register({
      key: "fan",
      name: "Fan",
      capabilities: [{ id: "power", kind: "switch" }],
    });
    await expect(
      other().devices.report({ key: "fan", states: { power: { on: 1 } } }),
    ).rejects.toThrow(/switch state/);
    await expect(
      other().devices.report({ key: "fan", states: { speed: { on: true } } }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("ends with the driver: a removed driver reports nothing more", async () => {
    let ctx: AppContext | undefined;
    const other = defineApp({
      id: "test.other",
      name: "Other",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [{ id: "devices.register", reason: "For the test." }],
      actions: [],
      events: [],
      async start(context) {
        ctx = context;
        await context.devices.register({
          key: "fan",
          name: "Fan",
          capabilities: [{ id: "power", kind: "switch" }],
        });
      },
      driver: { command: async () => {} },
    });
    const { core } = await lampsCore({
      apps: [{ app: other, origin: "official" }],
    });

    await core.apps.remove("test.other");

    await expect(
      ctx!.devices.report({ key: "fan", states: { power: { on: true } } }),
    ).rejects.toThrow(/has ended/);
  });

  it("settles what was pending when the core stopped, sending nothing again", async () => {
    const { core, plug } = await lampsCore();
    core.db
      .update(deviceCapabilities)
      .set({ desired: { on: true }, sync: "pending" })
      .where(eq(deviceCapabilities.deviceId, plug))
      .run();

    const deliver = vi.fn(async () => {});
    // Nothing waits after a restart. The test's clock runs past a deadline
    // and a resend's after it, so a resend the restart scheduled would show
    // however slow the runner.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const restarted = createDevices(core.db, {
      gate: core.gate,
      places: core.places,
      activity: core.activity,
      deliver,
      confirmMs: 10,
    });

    expect(restarted.get(plug)?.capabilities[0]).toMatchObject({
      sync: "conflict",
      desired: null,
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(deliver).not.toHaveBeenCalled();
    restarted.close();
  });
});

describe("who may use devices", () => {
  it("lets a shared client see, control and manage every device", async () => {
    const { core, maya, lamp, plug } = await lampsCore();
    const kitchen = sharedClient(core);

    const seen = await devicesSeenBy(core, kitchen.token);
    const seenByMaya = await devicesSeenBy(core, maya.token);
    const onPlug = await command(core, kitchen.token, plug, "power", {
      on: true,
    });
    const renamed = await post(
      core,
      "/api/devices/update",
      { id: lamp, name: "Kitchen light" },
      { token: kitchen.token },
    );

    expect(seen).toEqual(seenByMaya);
    expect(seen).toHaveLength(2);
    expect(onPlug.statusCode).toBe(200);
    expect(radio.received.map(({ actor }) => actor)).toEqual([
      { kind: "client", id: kitchen.id },
    ]);
    expect(renamed.json()).toMatchObject({ name: "Kitchen light" });
  });

  it("lets everyone in the household switch and manage things", async () => {
    const { core, lamp } = await lampsCore();
    const mia = personWithClient(core, "Mia");

    const sent = await command(core, mia.token, lamp, "light", { on: true });
    const renamed = await post(
      core,
      "/api/devices/update",
      { id: lamp, name: "Mia's lamp" },
      { token: mia.token },
    );

    expect(sent.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Mia's lamp" });
  });

  it("refuses a room that does not exist", async () => {
    const { core, maya, lamp } = await lampsCore();

    const moved = await post(
      core,
      "/api/devices/update",
      { id: lamp, roomId: "nowhere" },
      maya,
    );

    expect(moved.statusCode).toBe(404);
  });
});

describe("live clients", () => {
  it("follow every device, shared ones too", async () => {
    const { core, maya, lamp, plug } = await lampsCore();
    const kitchen = sharedClient(core);
    const mine = await openLive(core, maya.token);
    const shared = await openLive(core, kitchen.token);

    await command(core, maya.token, lamp, "light", { on: true });
    await settled();
    await command(core, maya.token, plug, "power", { on: true });
    await settled();

    const syncs = (messages: typeof mine.messages, id: string) =>
      messages
        .filter((message) => message.type === "device" && message.id === id)
        .map((message) =>
          message.device
            ? (message.device as { capabilities: { sync: string }[] })
                .capabilities[0]!.sync
            : null,
        );
    // Messages arrive over the socket after the requests have answered.
    await vi.waitFor(() => {
      // Pending, then confirmed.
      expect(syncs(mine.messages, lamp)).toEqual(["pending", "synced"]);
      expect(syncs(shared.messages, lamp)).toEqual(["pending", "synced"]);
      expect(syncs(mine.messages, plug)).toEqual(["pending", "synced"]);
      expect(syncs(shared.messages, plug)).toEqual(["pending", "synced"]);
    });
    mine.socket.terminate();
    shared.socket.terminate();
  });
});
