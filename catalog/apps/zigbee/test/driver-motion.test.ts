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
import {
  aqaraMotionSensor,
  hueMotionSensor,
  vallhorn,
} from "./motion-sensors.js";
import { PretendBridge } from "./pretend-bridge.js";

// Motion sensors against Zigbee2MQTT, played by the pretend bridge: what
// the driver registers and reports of their motion, light level and
// settings, and how it changes the settings: a Hue sensor's on
// <device>/set, an Aqara's wait as Zigbee2MQTT's occupancy_timeout option.

const bridge = await PretendBridge.start();
afterAll(() => bridge.stop());
beforeEach(() => bridge.reset());

let made = 0;
function fresh(name: string) {
  made += 1;
  return {
    key: `0x00178803000000${made.toString(16).padStart(2, "0")}`,
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

// A sensor joins and, once the driver listens to it, says what it shows, as
// a sleeping device does when it wakes: it is never asked. It joins saying
// nothing, since what it says as it joins reaches the driver only if the
// driver already listens: had it said its state, that report could stand in
// for the waking one, which would then land after a test began counting
// reports. Once the driver has reported what the sensor said, it has
// handled everything before it.
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
  await core.until(() => !!core.latest(key, "occupancy"), "reported");
}

const featuresOf = (core: Core, key: string) =>
  core.registered
    .get(key)
    ?.capabilities.find((each) => each.kind === "occupancy")?.features;

describe("a Hue motion sensor", () => {
  it("reports its motion, readings and settings, and its battery", async () => {
    const core = await running();
    const { key, name } = fresh("hue_motion");
    await joined(core, hueMotionSensor(key, name), {
      occupancy: false,
      temperature: 21.4,
      illuminance: 320,
      motion_sensitivity: "medium",
      occupancy_timeout: 60,
      led_indication: false,
      battery: 92,
      linkquality: 110,
    });

    expect(core.reports.at(-1)).toEqual({
      key,
      availability: "online",
      states: {
        temperature: { value: 21.4 },
        occupancy: {
          occupied: false,
          sensitivity: "medium",
          clearAfter: 60,
          indicator: false,
        },
        illuminance: { value: 320 },
      },
      battery: 92,
    });
    // It sleeps, so it is never asked: motion comes as it happens.
    await bridge.say(name, { occupancy: true, illuminance: 335 });
    await core.until(
      () => core.latest(key, "occupancy")?.occupied === true,
      "motion",
    );
    expect(core.latest(key, "illuminance")).toEqual({ value: 335 });
    expect(bridge.received).toEqual([]);
  });

  it("changes its settings on <device>/set, and its report confirms them", async () => {
    const core = await running();
    const { key, name } = fresh("hue_motion");
    await joined(core, hueMotionSensor(key, name, "SML003"), {
      occupancy: false,
      motion_sensitivity: "medium",
      occupancy_timeout: 60,
      led_indication: false,
    });
    expect(featuresOf(core, key)).toMatchObject({
      sensitivity: ["low", "medium", "high", "very_high", "max"],
    });

    await core.command(key, "occupancy", "occupancy", {
      sensitivity: "very_high",
    });
    await core.until(
      () => core.latest(key, "occupancy")?.sensitivity === "very_high",
      "very high",
    );
    await core.command(key, "occupancy", "occupancy", {
      clearAfter: 120,
      indicator: true,
    });
    await core.until(
      () => core.latest(key, "occupancy")?.clearAfter === 120,
      "two minutes",
    );

    expect(core.latest(key, "occupancy")).toEqual({
      occupied: false,
      sensitivity: "very_high",
      clearAfter: 120,
      indicator: true,
    });
    expect(bridge.received).toEqual([
      { topic: `${name}/set`, payload: { motion_sensitivity: "very_high" } },
      {
        topic: `${name}/set`,
        payload: { occupancy_timeout: 120, led_indication: true },
      },
    ]);
  });
});

describe("IKEA's VALLHORN", () => {
  it("reports its motion and light level, and has no settings", async () => {
    const core = await running();
    const { key, name } = fresh("vallhorn");
    await joined(core, vallhorn(key, name), {
      occupancy: true,
      illuminance: 12,
      battery: 80,
      timer: 60,
      lux_value: "always",
    });

    expect(featuresOf(core, key)).toEqual({
      senses: "motion",
      sensitivity: null,
      clearAfter: null,
      indicator: false,
    });
    expect(core.reports.at(-1)?.states).toEqual({
      occupancy: { occupied: true },
      illuminance: { value: 12 },
    });
  });
});

describe("an Aqara motion sensor", () => {
  // Zigbee2MQTT says no motion after its option; the test says it for it.
  async function added(
    core: Core,
    model: "RTCGQ11LM" | "RTCGQ14LM" = "RTCGQ11LM",
    state: Record<string, unknown> = {},
  ) {
    const sensor = fresh("aqara_motion");
    await joined(core, aqaraMotionSensor(sensor.key, sensor.name, model), {
      occupancy: true,
      illuminance: 40,
      device_temperature: 24,
      battery: 100,
      voltage: 3045,
      ...state,
    });
    return sensor;
  }

  it("waits as Zigbee2MQTT's occupancy_timeout option, which the driver changes and reports", async () => {
    const core = await running();
    const { key, name } = await added(core);
    expect(featuresOf(core, key)).toEqual({
      senses: "motion",
      sensitivity: null,
      clearAfter: { min: 60, max: 3600 },
      indicator: false,
    });
    // Without the option Zigbee2MQTT waits 90 s.
    expect(core.latest(key, "occupancy")).toEqual({
      occupied: true,
      clearAfter: 90,
    });

    const from = core.reports.length;
    await core.command(key, "occupancy", "occupancy", { clearAfter: 300 });

    expect(bridge.received).toEqual([
      {
        topic: "bridge/request/device/options",
        payload: {
          id: key,
          options: { occupancy_timeout: 300 },
          transaction: expect.stringMatching(/^sanctum-/),
        },
      },
    ]);
    await core.until(
      () => core.latest(key, "occupancy")?.clearAfter === 300,
      "five minutes",
    );
    // Once, though Zigbee2MQTT's configuration and its answer both say it.
    expect(core.reports.slice(from)).toEqual([
      { key, states: { occupancy: { occupied: true, clearAfter: 300 } } },
    ]);
    // What the sensor says next carries it too.
    await bridge.say(name, { occupancy: false });
    await core.until(
      () => core.latest(key, "occupancy")?.occupied === false,
      "no motion",
    );
    expect(core.latest(key, "occupancy")).toEqual({
      occupied: false,
      clearAfter: 300,
    });
  });

  it("reports an option changed in Zigbee2MQTT itself", async () => {
    const core = await running();
    const { key, name } = await added(core);

    await bridge.configure(name, { occupancy_timeout: 120 });
    await core.until(
      () => core.latest(key, "occupancy")?.clearAfter === 120,
      "two minutes",
    );
    await bridge.configure(name, { occupancy_timeout: undefined });
    await core.until(
      () => core.latest(key, "occupancy")?.clearAfter === 90,
      "back to Zigbee2MQTT's wait",
    );
  });

  it("fails when Zigbee2MQTT does not take the option, and reports nothing", async () => {
    const core = await running();
    const { key } = await added(core);
    bridge.takesOptions = false;
    const from = core.reports.length;

    await expect(
      core.command(key, "occupancy", "occupancy", { clearAfter: 300 }),
    ).rejects.toThrow("Failed to change options");
    expect(core.reports.slice(from)).toEqual([]);
  });

  it("changes a P1's sensitivity and blinking on <device>/set, with its wait as the option", async () => {
    const core = await running();
    const { key, name } = await added(core, "RTCGQ14LM", {
      occupancy: false,
      motion_sensitivity: "medium",
      trigger_indicator: true,
      detection_interval: 30,
    });
    expect(core.latest(key, "occupancy")).toEqual({
      occupied: false,
      sensitivity: "medium",
      clearAfter: 32,
      indicator: true,
    });

    await core.command(key, "occupancy", "occupancy", {
      sensitivity: "high",
      clearAfter: 120,
    });
    await core.until(
      () => core.latest(key, "occupancy")?.sensitivity === "high",
      "high",
    );

    expect(core.latest(key, "occupancy")).toEqual({
      occupied: false,
      sensitivity: "high",
      clearAfter: 120,
      indicator: true,
    });
    expect(bridge.received.map((each) => each.topic)).toEqual([
      "bridge/request/device/options",
      `${name}/set`,
    ]);
    expect(bridge.received[1]?.payload).toEqual({ motion_sensitivity: "high" });
  });

  it("registers a P1 again when it says a new detection_interval, its shortest wait", async () => {
    const core = await running();
    const { key, name } = await added(core, "RTCGQ14LM", {
      detection_interval: 30,
    });
    expect(featuresOf(core, key)).toMatchObject({
      clearAfter: { min: 30, max: 3600 },
    });

    await bridge.say(name, { detection_interval: 90 });
    await core.until(
      () =>
        (featuresOf(core, key) as { clearAfter?: { min: number } })?.clearAfter
          ?.min === 90,
      "registered again",
    );
    await core.until(
      () => core.latest(key, "occupancy")?.clearAfter === 92,
      "waits two seconds beyond its detection interval",
    );
  });
});
