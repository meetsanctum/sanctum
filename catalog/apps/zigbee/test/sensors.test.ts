import { describe, expect, it } from "vitest";

import { deviceEntries } from "../src/devices.js";
import { capabilityMappings } from "../src/exposes.js";
import { batteryOf, sensorState, type SensorMapping } from "../src/sensors.js";
import type { ZigbeeExpose } from "../src/types.js";
import { aqaraMotionSensor } from "./motion-sensors.js";
import { climateExposes, zigbeeDevice } from "./pretend-bridge.js";

// A climate sensor's readings, a light level and a device's battery
// (sensors.ts), from v1's sensor entities and room status
// (zigbee2mqtt-model.ts, room-status.ts), with its diagnostics left out by
// property rather than sorted out later.

const temperature: SensorMapping = {
  kind: "sensor",
  id: "temperature",
  property: "temperature",
  features: { measures: "temperature" },
  fahrenheit: false,
  readable: [],
};

describe("a climate sensor's exposes", () => {
  it("make a sensor for its temperature and one for its humidity, and nothing of its diagnostics", () => {
    expect(capabilityMappings(climateExposes())).toEqual([
      {
        kind: "sensor",
        id: "temperature",
        property: "temperature",
        features: { measures: "temperature" },
        fahrenheit: false,
        readable: [],
      },
      {
        kind: "sensor",
        id: "humidity",
        property: "humidity",
        features: { measures: "humidity" },
        fahrenheit: false,
        readable: [],
      },
    ]);
  });

  it("say what it reads again with /get, and that it says Fahrenheit", () => {
    const [reading] = capabilityMappings([
      { type: "numeric", property: "temperature", unit: "°F", access: 5 },
    ]);
    expect(reading).toMatchObject({
      fahrenheit: true,
      readable: ["temperature"],
    });
  });

  it("leave out a reading the device never publishes", () => {
    expect(
      capabilityMappings([
        { type: "numeric", property: "temperature", unit: "°C", access: 2 },
      ]),
    ).toEqual([]);
  });

  it("bring a sensor on a battery in as a device that sleeps", () => {
    const [entry] = deviceEntries([
      zigbeeDevice("0x00158d0001a2b3c4", "Office climate", climateExposes(), {
        type: "EndDevice",
        power_source: "Battery",
        definition: {
          vendor: "Aqara",
          model: "WSDCGQ11LM",
          description: "Temperature, humidity and pressure sensor",
          exposes: climateExposes(),
          supports_ota: false,
        },
      }),
    ]);
    expect(entry?.battery).toBe(true);
    expect(entry?.registration).toMatchObject({
      name: "Office climate",
      manufacturer: "Aqara",
      model: "WSDCGQ11LM",
      capabilities: [
        {
          id: "temperature",
          kind: "sensor",
          features: { measures: "temperature" },
        },
        { id: "humidity", kind: "sensor", features: { measures: "humidity" } },
      ],
      firmware: { updatable: false, sleeps: true },
      probe: false,
    });
  });
});

describe("a reading", () => {
  it("is the number the device says, in the measure's standard unit", () => {
    expect(sensorState(temperature, { temperature: 21.47 })).toEqual({
      value: 21.47,
    });
    expect(sensorState(temperature, { temperature: "19.5" })).toEqual({
      value: 19.5,
    });
    expect(
      sensorState({ ...temperature, fahrenheit: true }, { temperature: 71.6 }),
    ).toEqual({ value: 22 });
  });

  it("is none when the message says nothing of it, or nothing a room could read", () => {
    expect(sensorState(temperature, { humidity: 48 })).toBeNull();
    expect(sensorState(temperature, { temperature: null })).toBeNull();
    expect(sensorState(temperature, { temperature: -100 })).toBeNull();
    expect(
      sensorState(
        { ...temperature, id: "humidity", property: "humidity" },
        { humidity: 140 },
      ),
    ).toBeNull();
  });
});

describe("a light level", () => {
  const lux = (property: string, unit?: string): ZigbeeExpose => ({
    type: "numeric",
    name: property,
    property,
    ...(unit ? { unit } : {}),
    access: 5,
  });

  it("is Zigbee2MQTT 2's illuminance, in lux", () => {
    expect(capabilityMappings([lux("illuminance", "lx")])).toEqual([
      {
        kind: "sensor",
        id: "illuminance",
        property: "illuminance",
        features: { measures: "illuminance" },
        fahrenheit: false,
        readable: ["illuminance"],
      },
    ]);
  });

  it("is Zigbee2MQTT 1's illuminance_lux, whichever comes first", () => {
    // 1.x said a raw illuminance beside it, and some devices in lx too.
    for (const exposes of [
      [lux("illuminance"), lux("illuminance_lux", "lx")],
      [lux("illuminance", "lx"), lux("illuminance_lux", "lx")],
      [lux("illuminance_lux", "lx"), lux("illuminance", "lx")],
    ]) {
      expect(capabilityMappings(exposes)).toEqual([
        expect.objectContaining({
          id: "illuminance",
          property: "illuminance_lux",
        }),
      ]);
    }
  });

  it("is none of a raw reading, a dim or bright illumination, or a threshold", () => {
    expect(
      capabilityMappings([
        // Zigbee2MQTT 1's raw illuminance, and 2's when asked for.
        lux("illuminance"),
        lux("illuminance_raw"),
        // SONOFF's SNZB-03P and IKEA's older sensors.
        {
          type: "enum",
          property: "illumination",
          values: ["dim", "bright"],
          access: 1,
        },
        { type: "binary", property: "illuminance_above_threshold", access: 1 },
      ]),
    ).toEqual([]);
  });

  it("is a motion sensor's, beside its motion, but not its chip's temperature", () => {
    const [entry] = deviceEntries([
      aqaraMotionSensor("0x00158d0002b3c4d5", "Hall motion"),
    ]);
    expect(entry?.registration.capabilities).toEqual([
      expect.objectContaining({ id: "occupancy", kind: "occupancy" }),
      {
        id: "illuminance",
        kind: "sensor",
        features: { measures: "illuminance" },
      },
    ]);
  });

  it("is the lux the device says, up to more than full sunlight", () => {
    const illuminance: SensorMapping = {
      ...temperature,
      id: "illuminance",
      property: "illuminance",
      features: { measures: "illuminance" },
    };
    expect(sensorState(illuminance, { illuminance: 320 })).toEqual({
      value: 320,
    });
    expect(sensorState(illuminance, { illuminance: 0 })).toEqual({ value: 0 });
    expect(sensorState(illuminance, { illuminance: 120_000 })).toEqual({
      value: 120_000,
    });
    expect(sensorState(illuminance, { illuminance: -1 })).toBeNull();
    expect(sensorState(illuminance, { illuminance: 250_000 })).toBeNull();
  });
});

describe("a device's battery", () => {
  it("is its charge in whole percent, when its message says one", () => {
    expect(batteryOf({ battery: 87 })).toBe(87);
    expect(batteryOf({ battery: 64.5 })).toBe(65);
    expect(batteryOf({ temperature: 21 })).toBeUndefined();
    expect(batteryOf({ battery: 180 })).toBeUndefined();
  });
});
