import { createDriverCore } from "@meetsanctum/app-testkit";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { createZigbeeApp } from "../src/index.js";
import type { ZigbeeDevice } from "../src/types.js";
import { aqaraContactSensor, sonoffContactSensor } from "./contact-sensors.js";
import { PretendBridge } from "./pretend-bridge.js";

// Contact sensors against Zigbee2MQTT, played by the pretend bridge: what
// the driver registers and reports of their contact and battery, as they
// say it when they wake.

const bridge = await PretendBridge.start();
afterAll(() => bridge.stop());
beforeEach(() => bridge.reset());

let made = 0;
function fresh(name: string) {
  made += 1;
  return {
    key: `0x00158d00010000${made.toString(16).padStart(2, "0")}`,
    name: `${name}_${made}`,
  };
}

async function running() {
  const app = createZigbeeApp({ answerMs: 300, reconnectWaitMs: 300 });
  const core = createDriverCore(app, {
    services: { zigbee2mqtt: bridge.connection },
  });
  await core.start();
  onTestFinished(async () => {
    await core.stop();
    expect(core.refused).toEqual([]);
  });
  return core;
}

type Core = Awaited<ReturnType<typeof running>>;

// A sensor joins saying nothing and, once the driver listens to it, says
// what it shows, as a sleeping device does when it wakes: it is never
// asked.
async function joined(
  core: Core,
  device: ZigbeeDevice,
  state: Record<string, unknown>,
) {
  const key = device.ieee_address!;
  await bridge.add(device, {});
  // Its retained availability reaches the driver once it listens.
  await core.until(() => core.availability.get(key) === "online", "listening");
  await bridge.say(device.friendly_name!, state);
  await core.until(() => !!core.latest(key, "contact"), "reported");
}

describe("a contact sensor", () => {
  it("is registered with its contact and reports whether it is open, and its battery", async () => {
    const core = await running();
    const { key, name } = fresh("front_door");
    await joined(core, aqaraContactSensor(key, name), {
      contact: true,
      battery: 100,
      voltage: 3015,
      device_temperature: 24,
      linkquality: 120,
    });

    expect(core.registered.get(key)).toMatchObject({
      name,
      manufacturer: "Aqara",
      model: "MCCGQ11LM",
      capabilities: [{ id: "contact", kind: "contact" }],
    });
    expect(core.reports.at(-1)).toEqual({
      key,
      availability: "online",
      states: { contact: { open: false } },
      battery: 100,
    });

    // It sleeps, so it is never asked: it says so as it opens.
    await bridge.say(name, { contact: false });
    await core.until(() => core.latest(key, "contact")?.open === true, "open");
    await bridge.say(name, { contact: true });
    await core.until(
      () => core.latest(key, "contact")?.open === false,
      "closed",
    );
    expect(bridge.received).toEqual([]);
  });

  it("says nothing of its contact until a message has it", async () => {
    const core = await running();
    const { key, name } = fresh("window");
    await bridge.add(sonoffContactSensor(key, name), {});
    await core.until(
      () => core.availability.get(key) === "online",
      "listening",
    );
    const from = core.reports.length;

    // Its battery alone, as a sensor checks in before it has changed.
    await bridge.say(name, { battery: 63, battery_low: true, voltage: 2700 });
    await core.until(() => core.reports.length > from, "its battery");

    expect(core.reports.slice(from)).toEqual([
      { key, availability: "online", states: {}, battery: 63 },
    ]);
    expect(core.latest(key, "contact")).toBeUndefined();

    await bridge.say(name, { contact: false });
    await core.until(() => !!core.latest(key, "contact"), "its contact");
    expect(core.latest(key, "contact")).toEqual({ open: true });
  });

  it("takes no commands", async () => {
    const core = await running();
    const { key, name } = fresh("letterbox");
    await joined(core, aqaraContactSensor(key, name), { contact: true });

    await expect(
      core.command(key, "contact", "contact", {} as never),
    ).rejects.toMatchObject({ name: "ActionError", code: "not_found" });
    expect(bridge.received).toEqual([]);
  });
});
