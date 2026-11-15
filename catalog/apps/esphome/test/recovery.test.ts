import type { AppContext } from "@meetsanctum/app-sdk";
import { createDriverCore, type DriverCore } from "@meetsanctum/app-testkit";
import { ColorMode } from "esphome-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createFacts } from "../src/facts.js";
import { EmulatedDevice, newKey } from "./emulated-device.js";
import {
  add,
  announce,
  app,
  entitiesOf,
  migrationsFolder,
  nextMac,
  signalEntity,
  timings,
} from "./support.js";

// The app's own writes and the core's calls failing or overlapping: a
// device's state waits until what its connection told is kept, a problem
// is cleared once the core takes it, a removal or a new session never
// meets an older session's setup, and invalid readings never stop valid
// ones.

const writes = vi.hoisted(() => ({ save: vi.fn(), signal: vi.fn() }));

// Fail a write at the storage boundary while keeping the real database.
vi.mock("../src/facts.js", async (original) => {
  const actual = await original<typeof import("../src/facts.js")>();
  return {
    ...actual,
    createFacts(db: Parameters<typeof actual.createFacts>[0]) {
      const facts = actual.createFacts(db);
      return {
        ...facts,
        async save(...args: Parameters<typeof facts.save>) {
          await writes.save(...args);
          await facts.save(...args);
        },
        async signal(...args: Parameters<typeof facts.signal>) {
          await writes.signal(...args);
          await facts.signal(...args);
        },
      };
    },
  };
});

let core: DriverCore;
let context: AppContext;
let device: EmulatedDevice;

beforeEach(async () => {
  writes.save.mockReset();
  writes.signal.mockReset();
  const definition = app();
  core = createDriverCore(
    {
      ...definition,
      async start(ctx, event) {
        context = ctx;
        await definition.start?.(ctx, event);
      },
    },
    { migrationsFolder },
  );
  await core.start();
  device = await EmulatedDevice.start({
    name: "relay",
    mac: nextMac(),
    psk: newKey(),
    ...entitiesOf("switch"),
  });
  await announce(core, device);
});

afterEach(async () => {
  await core.stop();
  core.close();
  await device.stop();
});

it("retries a failed facts write before forwarding the device's state", async () => {
  writes.save.mockRejectedValueOnce(new Error("The database did not answer"));
  const key = await add(core, device);

  await expect
    .poll(() => core.latest(key, "switch-relay"))
    .toEqual({ on: false });

  expect(device.connections).toBe(2);
  expect(writes.save).toHaveBeenCalledTimes(2);
  await expect(
    core.call("esphome.device", { device: `device:${key}` }),
  ).resolves.toMatchObject({
    encrypted: true,
    version: "2026.10.2",
  });
});

it("retries clearing a problem when the core did not accept it", async () => {
  const key = await add(core, device);
  await core.until(() => core.availability.get(key) === "online", "online");
  const kept = device.psk;
  await device.unplug();
  device.psk = newKey();
  await device.listen();
  await core.until(() => core.problems.has(key), "key mismatch");
  const problem = vi.spyOn(context.devices, "problem");
  problem.mockRejectedValueOnce(new Error("The core did not answer"));
  await device.unplug();
  device.psk = kept;
  device.options.version = "2026.11.0";
  await device.listen();
  await announce(core, device);

  await core.until(() => !core.problems.has(key), "the problem cleared");

  expect(problem).toHaveBeenCalledTimes(2);
  expect(problem).toHaveBeenLastCalledWith({ key, problem: null });
});

it("handles a failed signal write and accepts the next reading", async () => {
  device.options.entities.push(signalEntity);
  device.states[199] = { state: -58 };
  writes.signal.mockRejectedValueOnce(new Error("The database did not answer"));
  const log = vi.spyOn(context, "log");
  const key = await add(core, device);
  await expect
    .poll(() => log.mock.calls.flat().join(" "))
    .toContain("could not save signal");

  device.setState(199, { state: -61 });

  await expect
    .poll(() => core.call("esphome.device", { device: `device:${key}` }))
    .toMatchObject({ signal: -61 });
});

it("accepts a light's valid state when its initial numeric readings are invalid", async () => {
  device.options.entities = entitiesOf("light").entities;
  device.states[101] = {
    state: true,
    brightness: Number.NaN,
    colorMode: ColorMode.RGB,
    red: Infinity,
    green: 1,
    blue: 0.2,
  };
  const key = await add(core, device);

  await expect.poll(() => core.latest(key, "light-bulb")).toEqual({ on: true });

  expect(device.connections).toBe(1);
  expect(core.refused).toEqual([]);
  await core.command(key, "light-bulb", "light", { brightness: 40 });
  await core.until(() => device.commands.length === 1, "the command");
});

it.each([Number.NaN, Infinity, -Infinity])(
  "ignores a signal reading of %s and accepts the next reading",
  async (invalid) => {
    device.options.entities.push(signalEntity);
    device.states[199] = { state: invalid };
    const key = await add(core, device);
    await expect
      .poll(() => core.latest(key, "switch-relay"))
      .toEqual({ on: false });

    expect(writes.signal).not.toHaveBeenCalled();
    await expect(
      core.call("esphome.device", { device: `device:${key}` }),
    ).resolves.toMatchObject({ signal: null });

    device.setState(199, { state: -61 });

    await expect
      .poll(() => core.call("esphome.device", { device: `device:${key}` }))
      .toMatchObject({ signal: -61 });
  },
);

it("does not restore a device removed while the startup list was being read", async () => {
  device.psk = null;
  await announce(core, device);
  const key = await add(core, device);
  await core.until(() => core.availability.get(key) === "online", "online");
  const snapshot = core.devices();
  await core.stop();
  let release!: (devices: typeof snapshot) => void;
  const list = vi.spyOn(context.devices, "list").mockReturnValueOnce(
    new Promise((done) => {
      release = done;
    }),
  );
  const starting = core.start();
  try {
    await expect.poll(() => list.mock.calls.length).toBe(1);
    await core.remove(key);
  } finally {
    release(snapshot);
    await starting;
  }

  await announce(core, device);

  expect(core.registered.has(key)).toBe(false);
  expect(core.found.map((each) => each.key)).toEqual([key]);
});

it("finishes pending setup before removing the device and its facts", async () => {
  let release!: () => void;
  writes.save.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const key = await add(core, device);
  await expect.poll(() => writes.save.mock.calls.length).toBe(1);
  let removed = false;
  const removing = core.remove(key).then(() => {
    removed = true;
  });
  try {
    await new Promise((done) => setTimeout(done, 20));
    expect(removed).toBe(false);
  } finally {
    release();
    await removing;
  }

  expect(core.registered.has(key)).toBe(false);
  expect(await createFacts(context.storage.db).read(key)).toBeNull();
});

it("keeps a new session's facts when an older setup was still finishing", async () => {
  let release!: () => void;
  writes.save.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const key = await add(core, device);
  await expect.poll(() => writes.save.mock.calls.length).toBe(1);
  try {
    await device.unplug();
    device.options.version = "2026.11.0";
    await device.listen();
    await announce(core, device);
    // The new session is checked once it follows the device's states, and
    // its setup is then the one waiting.
    await device.followed();
    await new Promise((done) => setTimeout(done, 20));
    expect(writes.save).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }

  await expect
    .poll(() => core.call("esphome.device", { device: `device:${key}` }))
    .toMatchObject({ version: "2026.11.0" });
});

it("waits for the new session's mapping before accepting commands", async () => {
  const light = entitiesOf("light");
  device.options.entities = light.entities;
  Object.assign(device.states, light.states);
  const key = await add(core, device);
  await core.until(() => core.availability.get(key) === "online", "online");
  let release!: () => void;
  writes.save.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  await device.unplug();
  device.options.entities[0]!.fields!.supportedColorModes = [
    ColorMode.RGB_COLD_WARM_WHITE,
  ];
  device.states[101] = { ...device.states[101], state: true };
  await device.listen();
  await announce(core, device);
  try {
    await expect.poll(() => writes.save.mock.calls.length).toBe(2);
    await expect(
      core.command(key, "light-bulb", "light", { colorTemperature: 300 }),
    ).rejects.toThrow("It isn't reachable");
    expect(device.commands).toEqual([]);
  } finally {
    release();
  }

  await core.until(
    () => core.latest(key, "light-bulb")?.on === true,
    "the new session's state",
  );
  await core.command(key, "light-bulb", "light", { colorTemperature: 300 });
  await core.until(() => device.commands.length === 1, "the command");
  expect(device.commands[0]?.fields).toMatchObject({
    colorMode: ColorMode.RGB_COLD_WARM_WHITE,
    colorTemperature: 300,
  });
});

it("hears what a device said as it closed while it was being taken in, its presses too", async () => {
  const button = await EmulatedDevice.start({
    name: "button",
    mac: nextMac(),
    psk: newKey(),
    ...entitiesOf("button"),
  });
  try {
    await announce(core, button);
    let release!: () => void;
    writes.save.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const key = await add(core, button);
    await expect.poll(() => writes.save.mock.calls.length).toBe(1);
    await button.followed();
    button.fire(106, "single");
    // The press reaches the session, which holds it while it's taken in.
    await new Promise((done) => setTimeout(done, 50));
    await button.unplug();
    // Its connection has seen it go before what it said is taken in.
    await core.until(() => core.availability.get(key) === "offline", "gone");
    release();

    await core.until(
      () => core.presses.some((each) => each.key === key),
      "the press",
    );
    expect(core.presses).toEqual([
      { key, capability: "event-button", action: "single" },
    ]);
  } finally {
    await button.stop();
  }
});

it("says a device's problem again when the core didn't take it", async () => {
  const key = await add(core, device);
  await core.until(() => core.availability.get(key) === "online", "online");
  const problem = vi.spyOn(context.devices, "problem");
  problem.mockRejectedValueOnce(new Error("The core did not answer"));

  await device.unplug();
  device.psk = newKey();
  await device.listen();

  await core.until(
    () => core.problems.get(key)?.id === "keyMismatch",
    "the problem said at last",
  );
  expect(problem).toHaveBeenCalledTimes(2);
  expect(problem).toHaveBeenLastCalledWith({ key, problem: "keyMismatch" });
});

it("never says a problem again once its device is repaired", async () => {
  const key = await add(core, device);
  await core.until(() => core.availability.get(key) === "online", "online");
  // The core takes each problem, but its answer never comes back, so the
  // app keeps saying it.
  const tell = context.devices.problem.bind(context.devices);
  const problem = vi.spyOn(context.devices, "problem");
  problem.mockImplementation(async (report) => {
    await tell(report);
    if (report.problem) throw new Error("The core's answer was lost");
  });
  const next = newKey();
  await device.unplug();
  device.psk = next;
  await device.listen();
  await expect.poll(() => problem.mock.calls.length).toBeGreaterThan(1);

  expect(await core.repair(key, { key: next })).toBeUndefined();
  await core.until(() => !core.problems.has(key), "the problem cleared");
  const cleared = problem.mock.calls.length;
  await new Promise((done) => setTimeout(done, timings.longestPauseMs * 3));

  expect(core.problems.has(key)).toBe(false);
  expect(problem.mock.calls.slice(cleared)).toEqual([]);
});

it("hears a press once when the device reconnects before its first session is taken in", async () => {
  const button = await EmulatedDevice.start({
    name: "button",
    mac: nextMac(),
    psk: newKey(),
    ...entitiesOf("button"),
  });
  try {
    await announce(core, button);
    let release!: () => void;
    writes.save.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const key = await add(core, button);
    await expect.poll(() => writes.save.mock.calls.length).toBe(1);
    await button.followed();
    button.fire(106, "single");
    await new Promise((done) => setTimeout(done, 50));
    // It goes and comes back, and its next session waits behind the first.
    await button.unplug();
    await core.until(() => core.availability.get(key) === "offline", "gone");
    await button.listen();
    await announce(core, button);
    await button.followed();
    release();

    await core.until(
      () => core.presses.some((each) => each.key === key),
      "the press",
    );
    await expect.poll(() => writes.save.mock.calls.length).toBe(2);
    expect(core.presses).toEqual([
      { key, capability: "event-button", action: "single" },
    ]);
  } finally {
    await button.stop();
  }
});
