import { motion } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { deviceEntries } from "../src/devices.js";
import { capabilityMappings } from "../src/exposes.js";
import {
  motionPayload,
  motionState,
  type MotionMapping,
} from "../src/motion.js";
import type { ZigbeeDevice, ZigbeeExpose } from "../src/types.js";
import {
  aqaraMotionSensor,
  hueMotionExposes,
  hueMotionSensor,
  vallhorn,
} from "./motion-sensors.js";

// A motion sensor's motion and settings (motion.ts), for the motion sensors
// the household has.

function motionOf(device: ZigbeeDevice, detectionInterval?: number) {
  const mapping = capabilityMappings(device.definition?.exposes ?? [], {
    model: device.definition?.model ?? null,
    detectionInterval,
  }).find((each): each is MotionMapping => each.kind === "motion");
  if (!mapping) {
    throw new Error(`${device.friendly_name} has no motion`);
  }
  return mapping;
}

const occupancyExpose = (access = 1): ZigbeeExpose => ({
  type: "binary",
  property: "occupancy",
  value_on: true,
  value_off: false,
  access,
});

describe("a motion sensor's exposes", () => {
  it("make a Hue SML001 a sensor of motion with three levels, a wait and a blinking light, beside its readings", () => {
    const [entry] = deviceEntries([
      hueMotionSensor("0x0017880103a4b5c6", "Office motion"),
    ]);

    expect(entry?.battery).toBe(true);
    expect(entry?.registration).toMatchObject({
      name: "Office motion",
      manufacturer: "Philips",
      model: "9290012607",
      capabilities: [
        {
          id: "temperature",
          kind: "sensor",
          features: { measures: "temperature" },
        },
        {
          id: "occupancy",
          kind: "motion",
          features: {
            sensitivity: ["low", "medium", "high"],
            clearAfter: { min: 0, max: 65535 },
            indicator: true,
          },
        },
        {
          id: "illuminance",
          kind: "sensor",
          features: { measures: "illuminance" },
        },
      ],
      firmware: { sleeps: true },
      probe: false,
    });
    expect(
      motion.features.safeParse(entry?.registration.capabilities[1]?.features)
        .success,
    ).toBe(true);
  });

  it("give an SML003 its five levels", () => {
    expect(
      motionOf(hueMotionSensor("0x01", "Hall motion", "SML003")).features
        .sensitivity,
    ).toEqual(["low", "medium", "high", "very_high", "max"]);
  });

  it("put a sensitivity's levels in the kind's order, leaving out any it does not know", () => {
    const levels = (values: string[]) =>
      motionOf({
        definition: { exposes: hueMotionExposes(values) },
      }).features.sensitivity;

    expect(levels(["high", "low", "medium", "sensitive"])).toEqual([
      "low",
      "medium",
      "high",
    ]);
    // One level is nothing to choose from.
    expect(levels(["high", "sensitive"])).toBeNull();
  });

  it("give IKEA's VALLHORN none of the settings: its timer and light threshold are for lights bound to it", () => {
    const [entry] = deviceEntries([vallhorn("0x02", "Hall motion")]);

    expect(entry?.registration.capabilities).toEqual([
      {
        id: "occupancy",
        kind: "motion",
        features: {
          sensitivity: null,
          clearAfter: null,
          indicator: false,
        },
      },
      {
        id: "illuminance",
        kind: "sensor",
        features: { measures: "illuminance" },
      },
    ]);
  });

  it("give an Aqara RTCGQ11LM Zigbee2MQTT's wait, from its blind minute to an hour", () => {
    const mapping = motionOf(aqaraMotionSensor("0x03", "Office motion"));

    expect(mapping.features).toEqual({
      sensitivity: null,
      clearAfter: { min: 60, max: 3600 },
      indicator: false,
    });
    expect(mapping.clearAfter).toEqual({ via: "option", unset: 90 });
  });

  it("give a P1 its sensitivity and blinking, and a shortest wait of its detection_interval", () => {
    const p1 = aqaraMotionSensor("0x04", "Office motion", "RTCGQ14LM");

    expect(motionOf(p1).features).toEqual({
      sensitivity: ["low", "medium", "high"],
      // 30 s, until it says its own.
      clearAfter: { min: 30, max: 3600 },
      indicator: true,
    });
    expect(motionOf(p1, 90).features.clearAfter).toEqual({
      min: 90,
      max: 3600,
    });
    expect(
      deviceEntries([p1], new Map([["0x04", 45]]))[0]?.registration
        .capabilities[0],
    ).toMatchObject({ features: { clearAfter: { min: 45, max: 3600 } } });
    // An option below its blind time would have no effect.
    expect(motionOf(p1, 7200).features.clearAfter).toBeNull();
    expect(
      motionOf(aqaraMotionSensor("0x05", "Hall motion", "RTCGQ12LM")).features,
    ).toMatchObject({
      sensitivity: null,
      clearAfter: { min: 60, max: 3600 },
      indicator: false,
    });
  });

  it("leave out a setting it cannot be told or does not publish, and motion it does not publish", () => {
    const mapping = motionOf({
      definition: {
        exposes: [
          occupancyExpose(),
          {
            type: "enum",
            property: "motion_sensitivity",
            values: ["low", "high"],
            access: 1,
          },
          { type: "numeric", property: "occupancy_timeout", access: 3 },
          { type: "binary", property: "led_indication", access: 2 },
        ],
      },
    });

    expect(mapping.features).toEqual({
      sensitivity: null,
      clearAfter: { min: 0, max: 65535 },
      indicator: false,
    });
    expect(capabilityMappings([occupancyExpose(2)])).toEqual([]);
  });
});

describe("a motion sensor's state", () => {
  const hue = motionOf(hueMotionSensor("0x06", "Office motion"));

  it("says whether it sees motion, with the settings it says", () => {
    expect(
      motionState(hue, {
        occupancy: true,
        illuminance: 320,
        motion_sensitivity: "high",
        occupancy_timeout: 30,
        led_indication: false,
      }),
    ).toEqual({
      motion: true,
      sensitivity: "high",
      clearAfter: 30,
      indicator: false,
    });
  });

  it("is none while its message says nothing of motion, and leaves out a setting it cannot take", () => {
    expect(motionState(hue, { illuminance: 320 })).toBeNull();
    expect(
      motionState(hue, {
        occupancy: false,
        motion_sensitivity: "sometimes",
        occupancy_timeout: -5,
        led_indication: "blink",
      }),
    ).toEqual({ motion: false });
  });

  it("has an Aqara's wait as Zigbee2MQTT's option, or what it waits without one", () => {
    const rtcgq11lm = motionOf(aqaraMotionSensor("0x07", "Office motion"));
    const p1 = motionOf(aqaraMotionSensor("0x08", "Hall motion", "RTCGQ14LM"));

    expect(motionState(rtcgq11lm, { occupancy: true })).toEqual({
      motion: true,
      clearAfter: 90,
    });
    expect(
      motionState(rtcgq11lm, { occupancy: true }, { option: 300 }),
    ).toEqual({ motion: true, clearAfter: 300 });
    expect(
      motionState(
        p1,
        {
          occupancy: false,
          motion_sensitivity: "low",
          trigger_indicator: true,
        },
        { detectionInterval: 30 },
      ),
    ).toEqual({
      motion: false,
      sensitivity: "low",
      clearAfter: 32,
      indicator: true,
    });
    // Before it reports, Zigbee2MQTT uses the model's default interval.
    expect(motionState(p1, { occupancy: false })).toEqual({
      motion: false,
      clearAfter: 32,
    });
    expect(
      motionState(
        p1,
        { occupancy: false },
        { detectionInterval: 90, option: 30 },
      ),
    ).toEqual({ motion: false, clearAfter: 92 });
    expect(
      motionState(
        p1,
        { occupancy: false },
        { detectionInterval: 90, option: 90 },
      ),
    ).toEqual({ motion: false, clearAfter: 90 });
    expect(
      motionState(p1, { occupancy: false }, { detectionInterval: 65535 }),
    ).toEqual({ motion: false });
  });
});

describe("a motion sensor's command", () => {
  it("sets a Hue sensor's own settings", () => {
    const hue = motionOf(hueMotionSensor("0x09", "Office motion"));

    expect(
      motionPayload(hue, {
        sensitivity: "high",
        clearAfter: 120,
        indicator: true,
      }),
    ).toEqual({
      set: {
        motion_sensitivity: "high",
        occupancy_timeout: 120,
        led_indication: true,
      },
      option: null,
    });
  });

  it("has Zigbee2MQTT's option set for an Aqara's wait", () => {
    const p1 = motionOf(
      aqaraMotionSensor("0x0a", "Office motion", "RTCGQ14LM"),
    );

    expect(
      motionPayload(p1, {
        sensitivity: "low",
        clearAfter: 120,
        indicator: false,
      }),
    ).toEqual({
      set: { motion_sensitivity: "low", trigger_indicator: false },
      option: 120,
    });
  });

  it("says its light's blinking as its expose does", () => {
    const mapping = motionOf({
      definition: {
        exposes: [
          occupancyExpose(),
          {
            type: "binary",
            property: "led_indication",
            value_on: "ON",
            value_off: "OFF",
            access: 7,
          },
        ],
      },
    });

    expect(motionPayload(mapping, { indicator: false }).set).toEqual({
      led_indication: "OFF",
    });
    expect(
      motionState(mapping, { occupancy: true, led_indication: "ON" }),
    ).toEqual({ motion: true, indicator: true });
  });
});
