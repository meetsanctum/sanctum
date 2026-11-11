import type { ZigbeeDevice, ZigbeeExpose } from "../src/types.js";
import { zigbeeDevice } from "./pretend-bridge.js";

// The motion sensors the household has, after Zigbee2MQTT 2.14.2's
// definitions of them (read on the dev Pi, 2026-10-31): Hue's SML001 to
// SML004, IKEA's VALLHORN and Aqara's RTCGQ11LM, T1 and P1, each with its
// readings, diagnostics and settings, on its battery.

// A feature Zigbee2MQTT publishes, sets and reads.
const all = 7;

const reading = (property: string, unit: string, access = 1): ZigbeeExpose => ({
  type: "numeric",
  name: property,
  property,
  unit,
  access,
});

const occupancy: ZigbeeExpose = {
  type: "binary",
  name: "occupancy",
  property: "occupancy",
  value_on: true,
  value_off: false,
  access: 1,
};

const onBattery = { type: "EndDevice", power_source: "Battery" } as const;

function sensor(
  key: string,
  name: string,
  definition: { vendor: string; model: string; description: string },
  exposes: ZigbeeExpose[],
  modelId: string,
): ZigbeeDevice {
  return zigbeeDevice(key, name, exposes, {
    ...onBattery,
    model_id: modelId,
    definition: { ...definition, exposes, supports_ota: true },
  });
}

/** A Hue motion sensor's exposes: SML001 and SML002 have three levels, SML003 and SML004 five. */
export function hueMotionExposes(
  levels: string[] = ["low", "medium", "high"],
): ZigbeeExpose[] {
  return [
    reading("temperature", "°C"),
    occupancy,
    reading("battery", "%"),
    reading("illuminance", "lx", 5),
    {
      type: "numeric",
      name: "occupancy_timeout",
      property: "occupancy_timeout",
      unit: "s",
      value_min: 0,
      value_max: 65535,
      access: all,
    },
    {
      type: "enum",
      name: "motion_sensitivity",
      property: "motion_sensitivity",
      values: levels,
      access: all,
    },
    {
      type: "binary",
      name: "led_indication",
      property: "led_indication",
      value_on: true,
      value_off: false,
      access: all,
    },
    reading("linkquality", "lqi"),
  ];
}

/** Hue's indoor motion sensor, SML001, or SML003 with its five levels. */
export function hueMotionSensor(
  key: string,
  name: string,
  model: "SML001" | "SML003" = "SML001",
) {
  return sensor(
    key,
    name,
    {
      vendor: "Philips",
      model: model === "SML001" ? "9290012607" : "9290030675",
      description: "Hue motion sensor",
    },
    hueMotionExposes(
      model === "SML001"
        ? ["low", "medium", "high"]
        : ["low", "medium", "high", "very_high", "max"],
    ),
    model,
  );
}

/**
 * IKEA's VALLHORN (E2134): its timer and light threshold steer lights bound
 * straight to it, not what it reports.
 */
export function vallhorn(key: string, name: string) {
  return sensor(
    key,
    name,
    {
      vendor: "IKEA",
      model: "E2134",
      description: "VALLHORN wireless motion sensor",
    },
    [
      occupancy,
      reading("illuminance", "lx", 5),
      reading("battery", "%", 5),
      {
        type: "numeric",
        name: "timer",
        property: "timer",
        unit: "s",
        value_min: 10,
        value_max: 65534,
        access: all,
      },
      {
        type: "enum",
        name: "lux_value",
        property: "lux_value",
        values: ["always", "only_when_dark"],
        access: all,
      },
      reading("linkquality", "lqi"),
    ],
    "VALLHORN Wireless Motion Sensor",
  );
}

/**
 * An Aqara motion sensor: RTCGQ11LM says motion only and has no settings;
 * a T1 (RTCGQ12LM) adds its detection_interval, and a P1 (RTCGQ14LM) its
 * sensitivity and blinking too.
 */
export function aqaraMotionSensor(
  key: string,
  name: string,
  model: "RTCGQ11LM" | "RTCGQ12LM" | "RTCGQ14LM" = "RTCGQ11LM",
) {
  const exposes: ZigbeeExpose[] = [
    occupancy,
    reading("illuminance", "lx"),
    reading("device_temperature", "°C"),
    reading("battery", "%"),
    reading("voltage", "mV"),
  ];
  if (model !== "RTCGQ11LM") {
    exposes.push({
      type: "numeric",
      name: "detection_interval",
      property: "detection_interval",
      unit: "s",
      value_min: 2,
      value_max: 65535,
      access: all,
    });
  }
  if (model === "RTCGQ14LM") {
    exposes.push(
      {
        type: "enum",
        name: "motion_sensitivity",
        property: "motion_sensitivity",
        values: ["low", "medium", "high"],
        access: all,
      },
      {
        type: "binary",
        name: "trigger_indicator",
        property: "trigger_indicator",
        value_on: true,
        value_off: false,
        access: all,
      },
    );
  }
  exposes.push(reading("linkquality", "lqi"));
  const named = {
    RTCGQ11LM: ["Motion sensor", "lumi.sensor_motion.aq2"],
    RTCGQ12LM: ["Motion sensor T1", "lumi.motion.agl02"],
    RTCGQ14LM: ["Motion sensor P1", "lumi.motion.ac02"],
  } as const;
  const [description, modelId] = named[model];
  return sensor(
    key,
    name,
    { vendor: "Aqara", model, description },
    exposes,
    modelId,
  );
}
