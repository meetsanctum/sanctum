import {
  isNotReady,
  type AppContext,
  type CoreCalls,
  type ServiceConnection,
} from "@meetsanctum/app-sdk";
import { createDriverCore } from "@meetsanctum/app-testkit";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import { createZigbeeApp } from "../src/index.js";
import {
  account,
  lightExpose,
  PretendBridge,
  switchExpose,
  zigbeeDevice,
} from "./pretend-bridge.js";

// Zigbee's start, against the pretend bridge: it returns once it has
// Zigbee2MQTT's device list, so a new version that can't reach its devices
// isn't kept, and until a list comes it says it's waiting for Zigbee2MQTT,
// keeping nothing of a start that didn't finish.

const bridge = await PretendBridge.start();
afterAll(() => bridge.stop());
beforeEach(() => bridge.reset());

let made = 0;
function fresh(name: string) {
  made += 1;
  return {
    key: `0x00178801000001${made.toString(16).padStart(2, "0")}`,
    name: `${name}_${made}`,
  };
}

function zigbee(
  options: {
    services?: Record<string, ServiceConnection>;
    unanswered?: (keyof CoreCalls)[];
    listWithinMs?: number;
    onContext?: (ctx: AppContext) => void;
  } = {},
) {
  const app = createZigbeeApp({
    listWithinMs: options.listWithinMs ?? 300,
    answerMs: 300,
    reconnectWaitMs: 300,
  });
  const core = createDriverCore(
    {
      ...app,
      async start(ctx, info) {
        options.onContext?.(ctx);
        await app.start?.(ctx, info);
      },
    },
    {
      services: options.services ?? { zigbee2mqtt: bridge.connection },
      ...(options.unanswered ? { unanswered: options.unanswered } : {}),
    },
  );
  onTestFinished(() => core.stop());
  const status = () =>
    app.actions
      .find((each) => each.id === "zigbee.status")!
      .run({} as AppContext, {});
  return { core, status };
}

// What a start threw, which these tests expect it to.
async function thrown(starting: Promise<unknown>) {
  const error = await starting.then(
    () => undefined,
    (each: unknown) => each,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe("Zigbee's start", () => {
  it("returns once every device in Zigbee2MQTT's list is registered and said to be here", async () => {
    const lamp = fresh("bulb");
    const plug = fresh("plug");
    await bridge.add(zigbeeDevice(lamp.key, lamp.name, [lightExpose()]), {
      state: "ON",
      brightness: 200,
    });
    await bridge.add(zigbeeDevice(plug.key, plug.name, [switchExpose()]), {
      state: "OFF",
    });
    const { core, status } = zigbee();

    await core.start();

    expect([...core.registered.keys()]).toEqual(
      expect.arrayContaining([lamp.key, plug.key]),
    );
    expect(core.presented.at(-1)).toEqual(
      expect.arrayContaining([lamp.key, plug.key]),
    );
    expect(await status()).toMatchObject({
      broker: "connected",
      bridge: "online",
    });
  });

  it("waits for Zigbee2MQTT while no device list comes, running nothing meanwhile", async () => {
    // Zigbee2MQTT hasn't published its list on this base topic.
    const { core, status } = zigbee({
      services: {
        zigbee2mqtt: { ...bridge.connection, baseTopic: "elsewhere" },
      },
    });

    const error = await thrown(core.start());

    expect(isNotReady(error)).toBe(true);
    expect(error.message).toBe("Waiting for Zigbee2MQTT");
    await expect(status()).rejects.toThrow("not running");
  });

  it("waits for Zigbee2MQTT while the broker doesn't let it in, registering nothing", async () => {
    const { key, name } = fresh("plug");
    await bridge.add(zigbeeDevice(key, name, [switchExpose()]), {
      state: "OFF",
    });
    const { core, status } = zigbee({
      services: {
        zigbee2mqtt: {
          ...bridge.connection,
          mqtt: { ...bridge.connection.mqtt!, password: "wrong" },
        },
      },
    });

    const error = await thrown(core.start());

    expect(isNotReady(error)).toBe(true);
    expect(core.registered.size).toBe(0);
    await expect(status()).rejects.toThrow("not running");
    await expect(core.openPairing(60)).rejects.toThrow("not running");
    expect(account.password).not.toBe("wrong");
  });

  it("says at once that it waits when no broker answers, rather than waiting for a list", async () => {
    const { core } = zigbee({
      services: {
        zigbee2mqtt: {
          ...bridge.connection,
          mqtt: { ...bridge.connection.mqtt!, url: "mqtt://127.0.0.1:1" },
        },
      },
      listWithinMs: 10_000,
    });
    const asked = Date.now();

    const error = await thrown(core.start());

    expect(isNotReady(error)).toBe(true);
    expect(Date.now() - asked).toBeLessThan(5_000);
  });

  it("waits for Zigbee2MQTT while the core can't hand it the service", async () => {
    const { core } = zigbee({ services: {} });

    const error = await thrown(core.start());

    expect(isNotReady(error)).toBe(true);
    expect(error.message).toBe("Waiting for Zigbee2MQTT");
  });

  it("fails when the core can't hear which devices are here, running nothing", async () => {
    const { key, name } = fresh("bulb");
    await bridge.add(zigbeeDevice(key, name, [lightExpose()]), {
      state: "OFF",
    });
    const { core, status } = zigbee({ unanswered: ["present"] });

    const error = await thrown(core.start());

    expect(isNotReady(error)).toBe(false);
    expect(error.message).toMatch(/could not say which devices are here/);
    await expect(status()).rejects.toThrow("not running");
  });

  it("finishes registering a list that arrived on time even when processing exceeds the arrival deadline", async () => {
    const { key, name } = fresh("bulb");
    await bridge.add(zigbeeDevice(key, name, [lightExpose()]), {
      state: "OFF",
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    onTestFinished(() => release());
    let isRegistering = false;
    const { core } = zigbee({
      onContext(ctx) {
        const register = ctx.devices.register;
        vi.spyOn(ctx.devices, "register").mockImplementation(async (input) => {
          isRegistering = true;
          await waiting;
          return register(input);
        });
      },
    });
    const starting = core.start();
    starting.catch(() => undefined);
    await core.until(() => isRegistering, "the list to start registering");
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();

    await expect(starting).resolves.toBeUndefined();
    expect(core.registered.has(key)).toBe(true);
    expect(core.presented.at(-1)).toContain(key);
  });

  it("starts no more registrations after closing during a list", async () => {
    for (const name of ["bulb", "plug"]) {
      const device = fresh(name);
      await bridge.add(
        zigbeeDevice(device.key, device.name, [switchExpose()]),
        { state: "OFF" },
      );
    }
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    onTestFinished(() => release());
    const registered: string[] = [];
    const { core } = zigbee({
      onContext(ctx) {
        const register = ctx.devices.register;
        vi.spyOn(ctx.devices, "register").mockImplementation(async (input) => {
          registered.push(input.key);
          await waiting;
          return register(input);
        });
      },
    });
    const starting = core.start();
    starting.catch(() => undefined);
    await core.until(() => registered.length > 0, "the first registration");

    await core.stop();
    release();
    await thrown(starting);

    expect(registered).toHaveLength(1);
    expect(core.presented).toEqual([]);
  });
});

describe("Zigbee's resume", () => {
  it("says its devices, which are here and their states again, without reconnecting", async () => {
    const lamp = fresh("bulb");
    await bridge.add(zigbeeDevice(lamp.key, lamp.name, [lightExpose()]), {
      state: "ON",
      brightness: 200,
    });
    const { core, status } = zigbee();
    await core.start();
    await core.until(
      () => core.reports.some(({ key }) => key === lamp.key),
      "its first state",
    );
    const said = core.presented.length;
    const reported = core.reports.length;

    await core.resume();

    expect(core.presented).toHaveLength(said + 1);
    expect(core.presented.at(-1)).toContain(lamp.key);
    await core.until(
      () => core.reports.length > reported,
      "its state, read again",
    );
    expect(await status()).toMatchObject({ broker: "connected" });
  });
});
