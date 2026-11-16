import { afterEach, describe, expect, it } from "vitest";
import { maxAppSecrets } from "@meetsanctum/app-sdk";

import { secretOf } from "../src/driver.js";
import { newKey, type EmulatedDevice } from "./emulated-device.js";
import {
  add,
  announce,
  keyOf,
  signalEntity,
  startHome,
  timings,
} from "./support.js";

// ESPHome's devices from being found to being removed: added with the key
// they were flashed with, or without encryption where they have none, never
// talked to without their key once Sanctum has it, repaired when it stops
// matching, and reconnected from the core's record after a restart.

let home: Awaited<ReturnType<typeof startHome>>;

afterEach(async () => {
  await home?.stop();
});

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

// Reflashes a device, which comes back with another key or none.
async function reflash(device: EmulatedDevice, psk: string | null) {
  await device.unplug();
  device.psk = psk;
  await device.listen();
}

describe("finding devices", () => {
  it("lists those on the network with what adding each needs", async () => {
    home = await startHome();
    const keyed = await home.plugIn({
      name: "porch",
      friendlyName: "Porch light",
    });
    const open = await home.plugIn({ name: "fan", psk: null });
    const waiting = await home.plugIn({
      name: "new",
      psk: null,
      waiting: true,
      kind: "sensor",
    });
    const rows = () =>
      home.core.found.map(({ key, name, description, asks }) => ({
        key,
        name,
        description,
        asks: asks.map((each) => each.id),
      }));

    // One waiting for a key says what it has, once a connection under the
    // zero key has told it.
    await home.core.until(
      () => rows().at(-1)?.description === "temperature",
      "what it has",
    );
    expect(rows()).toEqual([
      {
        key: keyOf(keyed.options.mac),
        name: "Porch light",
        description: "Needs its encryption key",
        asks: ["key"],
      },
      {
        key: keyOf(open.options.mac),
        name: "fan",
        description: "Not encrypted",
        asks: [],
      },
      {
        key: keyOf(waiting.options.mac),
        name: "new",
        description: "temperature",
        asks: [],
      },
    ]);
  });

  it("leaves out a device once it's added, and one no longer announced", async () => {
    home = await startHome();
    const kept = await home.plugIn();
    const gone = await home.plugIn();
    await add(home.core, kept);
    await home.core.discovered({
      found: [],
      lost: [{ service: "_esphomelib._tcp", name: gone.options.name }],
    });

    expect(home.core.found).toEqual([]);
  });

  it("closes a pending description connection when the app stops", async () => {
    home = await startHome();
    const device = await home.plugIn();
    device.psk = null;
    device.waiting = true;
    device.answersHello = false;
    await announce(home.core, device);
    await home.core.until(() => device.activeConnections > 0, "connecting");

    await home.core.stop();

    await expect.poll(() => device.activeConnections, { timeout: 200 }).toBe(0);
  });
});

describe("adding a device", () => {
  it("takes the key it was flashed with, keeping it before the device", async () => {
    home = await startHome();
    const device = await home.plugIn({
      kind: "light",
      friendlyName: "Porch light",
    });
    const key = await add(home.core, device);

    expect(home.core.registered.get(key)).toMatchObject({
      name: "Porch light",
      manufacturer: "Espressif",
      firmware: { version: "2026.10.2", updatable: false, sleeps: false },
      capabilities: [{ id: "light-bulb", kind: "light" }],
    });
    expect(home.core.secrets.get(secretOf(key))).toBe(device.psk);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );
    // One connection checked the key and goes on as its own.
    expect(device.connections).toBe(1);
  });

  it("refuses a key that doesn't match, or isn't a key, and keeps nothing", async () => {
    home = await startHome();
    const device = await home.plugIn();
    const key = keyOf(device.options.mac);

    for (const typed of [newKey(), "not a key"]) {
      expect(await home.core.add(key, { key: typed })).toEqual({
        refused: { question: "key", refusal: "wrongKey" },
      });
    }
    expect(home.core.registered.has(key)).toBe(false);
    expect(home.core.secrets.size).toBe(0);
    expect(home.core.found.map((each) => each.key)).toEqual([key]);
  });

  it("closes its checked connection when the key cannot be saved", async () => {
    home = await startHome();
    const device = await home.plugIn();
    for (let index = 0; index < maxAppSecrets; index += 1) {
      home.core.secrets.set(`full:${index}`, "kept");
    }

    await expect(add(home.core, device)).rejects.toThrow("secrets already");

    expect(home.core.registered.size).toBe(0);
    await expect.poll(() => device.activeConnections, { timeout: 200 }).toBe(0);
  });

  it("adds a device without encryption as one", async () => {
    home = await startHome();
    const device = await home.plugIn({ psk: null });
    const key = await add(home.core, device);

    expect(home.core.registered.has(key)).toBe(true);
    expect(home.core.secrets.size).toBe(0);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );
  });

  it("forgets an old key when adding a device without encryption", async () => {
    home = await startHome();
    const device = await home.plugIn({ psk: null });
    const key = keyOf(device.options.mac);
    // A forced removal while the app was stopped could not deliver its cleanup.
    home.core.secrets.set(secretOf(key), newKey());
    await add(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );

    await device.unplug();
    await home.core.until(
      () => home.core.availability.get(key) === "offline",
      "offline",
    );
    await device.listen();
    await announce(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online again",
    );

    expect(home.core.secrets.has(secretOf(key))).toBe(false);
    expect(home.core.problems.has(key)).toBe(false);
  });

  it("is the same device when it's added again", async () => {
    home = await startHome();
    const device = await home.plugIn();
    const key = await add(home.core, device);

    expect(await home.core.add(key, { key: device.psk! })).toBeUndefined();
    expect(device.connections).toBe(1);
  });
});

describe("its key", () => {
  it("is never left out: a device reflashed without encryption is dropped and waits for Repair", async () => {
    home = await startHome();
    const device = await home.plugIn({ kind: "switch" });
    const key = await add(home.core, device);
    // Online, and what it said as it was added, which follows just after.
    await home.core.until(
      () =>
        home.core.availability.get(key) === "online" &&
        home.core.latest(key, "switch-relay") !== undefined,
      "online with its first state",
    );
    const reported = home.core.reports.length;

    await reflash(device, null);
    await home.core.until(
      () => home.core.problems.has(key),
      "its key's problem",
    );

    expect(home.core.problems.get(key)?.id).toBe("keyMismatch");
    // Nothing it said without its key counts, and nothing is sent to it.
    expect(
      home.core.reports
        .slice(reported)
        .filter((each) => Object.keys(each.states).length > 0),
    ).toEqual([]);
    await expect(
      home.core.command(key, "switch-relay", "switch", { on: true }),
    ).rejects.toThrow();
    expect(device.commands).toEqual([]);
  });

  it("stops matching after a reflash: it waits for Repair without being hammered, and Repair takes the new one", async () => {
    home = await startHome();
    const device = await home.plugIn({ kind: "switch" });
    const key = await add(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );

    const next = newKey();
    await reflash(device, next);
    await home.core.until(
      () => home.core.problems.get(key)?.id === "keyMismatch",
      "keyMismatch",
    );
    const tried = device.connections;
    await wait(timings.longestPauseMs * 4);
    expect(device.connections).toBe(tried);

    expect(await home.core.repair(key, { key: newKey() })).toEqual({
      refused: { question: "key", refusal: "wrongKey" },
    });
    expect(home.core.secrets.get(secretOf(key))).not.toBe(next);

    expect(await home.core.repair(key, { key: next })).toBeUndefined();
    expect(home.core.secrets.get(secretOf(key))).toBe(next);
    await home.core.until(
      () => !home.core.problems.has(key),
      "the problem cleared",
    );
    await home.core.command(key, "switch-relay", "switch", { on: true });
    await home.core.until(() => device.commands.length === 1, "the command");
  });

  it("is asked for once a device without one is flashed with one", async () => {
    home = await startHome();
    const device = await home.plugIn({ psk: null });
    const key = await add(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );

    const flashed = newKey();
    await reflash(device, flashed);
    await home.core.until(
      () => home.core.problems.get(key)?.id === "keyAdded",
      "keyAdded",
    );
    expect(await home.core.repair(key, { key: flashed })).toBeUndefined();

    expect(home.core.secrets.get(secretOf(key))).toBe(flashed);
    await home.core.until(
      () => !home.core.problems.has(key),
      "the problem cleared",
    );
  });

  it("is tried again once the device announces itself anew", async () => {
    home = await startHome();
    const device = await home.plugIn();
    const key = await add(home.core, device);
    const kept = device.psk;
    await reflash(device, newKey());
    await home.core.until(
      () => home.core.problems.has(key),
      "its key's problem",
    );

    // Flashed back with the key Sanctum has, and announced with its new version.
    await reflash(device, kept);
    device.options.version = "2026.11.0";
    await announce(home.core, device);
    await home.core.until(
      () => !home.core.problems.has(key),
      "the problem cleared",
    );
  });
});

describe("its connection", () => {
  it("tries a halted device again when only its network address changes", async () => {
    home = await startHome();
    const device = await home.plugIn();
    const key = await add(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );
    const kept = device.psk;
    await reflash(device, newKey());
    await home.core.until(() => home.core.problems.has(key), "key mismatch");
    await device.unplug();
    device.psk = kept;
    device.port = 0;
    await device.listen();
    await announce(home.core, device);

    await home.core.until(
      () => !home.core.problems.has(key),
      "the problem cleared",
    );
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online again",
    );
  });

  it("isn't used when another device answers at its address", async () => {
    home = await startHome();
    const device = await home.plugIn({ psk: null });
    const key = await add(home.core, device);
    await device.unplug();
    // Another device takes its address, claiming nothing else.
    device.options.mac = "AA:BB:CC:FF:FF:FF";
    await device.listen();

    await home.core.until(
      () => home.core.availability.get(key) === "offline",
      "offline",
    );
    expect(home.core.problems.has(key)).toBe(false);
  });

  it("says a device is offline once it's been gone too long, and online once it's back", async () => {
    home = await startHome();
    const device = await home.plugIn();
    const key = await add(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );

    await device.unplug();
    await home.core.until(
      () => home.core.availability.get(key) === "offline",
      "offline",
    );
    await device.listen();
    await announce(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online again",
    );
  });

  it("never says a device that sleeps is offline", async () => {
    home = await startHome();
    const device = await home.plugIn({ sleeps: true });
    const key = await add(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );

    await device.unplug();
    await home.core.until(
      () => home.core.availability.get(key) === "unknown",
      "out of reach",
      timings.offlineMs * 10,
    );

    expect(
      home.core.reports.some(
        (each) => each.key === key && each.availability === "offline",
      ),
    ).toBe(false);
  });

  it("comes back after a restart from the core's record and the key kept", async () => {
    home = await startHome();
    const device = await home.plugIn({ kind: "switch" });
    const key = await add(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );

    await home.core.stop();
    await home.core.start();
    expect(home.core.presented.at(-1)).toEqual([key]);
    await announce(home.core, device);
    await expect
      .poll(() =>
        home.core.command(key, "switch-relay", "switch", { on: true }).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    await home.core.until(() => device.commands.length === 1, "the command");
    expect(device.connections).toBe(2);
  });
});

describe("what it reads", () => {
  it("takes a reading of zero, which the device sends with no value", async () => {
    home = await startHome();
    const device = await home.plugIn({
      entities: [
        {
          type: "sensor",
          key: 110,
          objectId: "light_level",
          name: "Light level",
          fields: { deviceClass: "illuminance", unitOfMeasurement: "lx" },
        },
      ],
      states: { 110: { state: 10 } },
    });
    const key = await add(home.core, device);
    await home.core.until(
      () => home.core.latest(key, "sensor-light_level")?.value === 10,
      "10 lx",
    );

    device.setState(110, { state: 0 });

    await home.core.until(
      () => home.core.latest(key, "sensor-light_level")?.value === 0,
      "0 lx",
    );
  });
});

describe("removing a device", () => {
  it("closes its connection and forgets its key, so it's found again", async () => {
    home = await startHome();
    const device = await home.plugIn();
    const key = await add(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );

    await home.core.remove(key);

    expect(home.core.secrets.has(secretOf(key))).toBe(false);
    expect(home.core.found.map((each) => each.key)).toEqual([key]);
    await home.core.until(
      () => device.connections === 1 && openSessions(device) === 0,
      "closed",
    );
  });
});

describe("its page", () => {
  it("says how it's reached, what it runs, its signal and what the app doesn't bring in", async () => {
    home = await startHome();
    const device = await home.plugIn({
      kind: "switch",
      version: "2026.10.2",
      entities: [
        { type: "switch", key: 102, objectId: "relay", name: "Relay" },
        signalEntity,
        {
          type: "number",
          key: 120,
          objectId: "brightness",
          name: "Display brightness",
        },
        { type: "button", key: 121, objectId: "restart", name: "Restart" },
      ],
      states: { 102: { state: false }, 199: { state: -58 } },
    });
    const key = await add(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );

    const page = await home.core.call("esphome.device", {
      device: `device:${key}`,
    });
    expect(page).toMatchObject({
      address: `${device.host}:${device.port}`,
      encrypted: true,
      version: "2026.10.2",
      unused: ["Display brightness", "Restart"],
      sleeps: false,
    });
    await expect
      .poll(
        async () =>
          (await home.core.call("esphome.device", {
            device: `device:${key}`,
          })) as { signal: number | null },
      )
      .toMatchObject({ signal: -58 });
  });
});

// How many of its sessions are open, from how many it still follows.
function openSessions(device: EmulatedDevice) {
  return (device as unknown as { subscribed: Set<unknown> }).subscribed.size;
}
