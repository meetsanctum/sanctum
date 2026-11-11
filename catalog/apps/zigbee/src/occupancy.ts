import {
  occupancy,
  occupancySensitivities,
  type OccupancyCommand,
  type OccupancyFeatures,
  type OccupancySensitivity,
  type OccupancyState,
} from "@meetsanctum/app-sdk";

import { access, type ZigbeeExpose } from "./types.js";
import { numericValue, powerValue, stringValue } from "./values.js";

// A motion sensor's occupancy and its settings, as Zigbee2MQTT publishes
// them. v1 made a generic binary sensor of occupancy (zigbee2mqtt-model.ts,
// Pragmata v1-final) and had no settings; here occupancy is its own kind,
// and the settings a sensor has are the kind's: its sensitivity, how long it
// waits after the last motion before it says none, and whether its light
// blinks on motion, each the device's own expose by its exact property.
// Aqara's motion sensors only ever say motion: Zigbee2MQTT says no motion
// itself, after its occupancy_timeout device option, so that option is how
// long they wait.

type Binary = { property: string; on: unknown; off: unknown };

/** Where a sensor's wait after the last motion is set. */
export type ClearAfterSetting =
  /** Its own setting, such as a Hue sensor's occupancy_timeout. */
  | { via: "device"; property: string }
  /**
   * Zigbee2MQTT's occupancy_timeout option, for a sensor that only says
   * motion. Without the option Zigbee2MQTT waits a fixed time, or the
   * sensor's detection_interval plus two seconds.
   */
  | { via: "option"; unset: number }
  | { via: "option"; unset: "detectionInterval"; defaultInterval: number };

export type OccupancyMapping = {
  kind: "occupancy";
  id: "occupancy";
  /** The binary its occupancy is in, and the values it takes. */
  state: Binary;
  features: OccupancyFeatures;
  /** The property of its sensitivity, such as motion_sensitivity. */
  sensitivity?: string;
  clearAfter?: ClearAfterSetting;
  /** The binary of its light's blinking, such as led_indication. */
  indicator?: Binary;
  /** The properties Zigbee2MQTT can read again with /get. */
  readable: string[];
};

/** What the driver knows of a device beyond its exposes. */
export type DeviceFacts = {
  /** Zigbee2MQTT's model for it, such as RTCGQ11LM. */
  model?: string | null;
  /** The detection_interval it last said, in seconds. */
  detectionInterval?: number;
};

/** How long Zigbee2MQTT waits for a sensor it says no motion for. */
export type Timing = {
  /** Its occupancy_timeout option, in seconds, when it has one. */
  option?: number;
  detectionInterval?: number;
};

// Aqara's motion sensors, by Zigbee2MQTT's model, which Zigbee2MQTT says
// no motion for. Each is blind for a while after it sees motion, so a
// shorter wait would say no motion while someone is still there:
// RTCGQ11LM for 60 s, and Zigbee2MQTT waits 90 s for it without the
// option; the others for their detection_interval, which Zigbee2MQTT
// waits plus two seconds without a long enough option, taken as 30 s on
// a P1 and 60 s on the rest until the sensor says its own.
const timedByZigbee2mqtt = new Map<
  string,
  { min: number; unset: number | "detectionInterval" }
>([
  ["RTCGQ11LM", { min: 60, unset: 90 }],
  // T1, high precision, P1 and E1.
  ["RTCGQ12LM", { min: 60, unset: "detectionInterval" }],
  ["RTCGQ13LM", { min: 60, unset: "detectionInterval" }],
  ["RTCGQ14LM", { min: 30, unset: "detectionInterval" }],
  ["RTCGQ15LM", { min: 60, unset: "detectionInterval" }],
]);
// The longest wait offered for them, an hour.
const optionMax = 3600;

const publishedAndSettable = access.state | access.set;

// A setting it publishes and can be told, by its exact property.
function setting(
  exposes: readonly ZigbeeExpose[],
  type: string,
  ...properties: string[]
) {
  return exposes.find(
    (each) =>
      each.type === type &&
      properties.includes(each.property ?? "") &&
      (each.access === undefined ||
        (each.access & publishedAndSettable) === publishedAndSettable),
  );
}

function binaryOf(expose: ZigbeeExpose): Binary {
  return {
    property: expose.property!,
    on: expose.value_on ?? true,
    off: expose.value_off ?? false,
  };
}

// Its sensitivity's levels the kind knows, lowest first, if it has two.
function levelsOf(expose: ZigbeeExpose): OccupancySensitivity[] | null {
  const values = Array.isArray(expose.values) ? expose.values : [];
  const levels = occupancySensitivities.filter((level) =>
    values.includes(level),
  );
  return levels.length >= 2 ? levels : null;
}

const clamp = (value: number) => Math.min(65_535, Math.max(0, value));

/** A whole number of seconds the kind takes, or null for anything else. */
export function secondsOf(value: unknown) {
  const seconds = numericValue(value);
  return seconds !== null && seconds >= 0 && seconds <= 65_535
    ? Math.round(seconds)
    : null;
}

// The range of a sensor's own wait, as its expose gives it.
function rangeOf(expose: ZigbeeExpose) {
  const min = Math.ceil(clamp(numericValue(expose.value_min) ?? 0));
  const max = Math.floor(clamp(numericValue(expose.value_max) ?? 65_535));
  return min <= max ? { min, max } : null;
}

/**
 * A motion sensor's occupancy, with the settings it has; null for any
 * other expose.
 */
export function mapOccupancy(
  expose: ZigbeeExpose,
  exposes: readonly ZigbeeExpose[],
  facts: DeviceFacts = {},
): OccupancyMapping | null {
  if (
    expose.type !== "binary" ||
    expose.property !== "occupancy" ||
    (expose.access !== undefined && (expose.access & access.state) === 0)
  ) {
    return null;
  }
  const mapping: OccupancyMapping = {
    kind: "occupancy",
    id: "occupancy",
    state: binaryOf(expose),
    features: {
      senses: "motion",
      sensitivity: null,
      clearAfter: null,
      indicator: false,
    },
    readable: [],
  };
  const parts = [expose];
  const sensitivity = setting(exposes, "enum", "motion_sensitivity");
  const levels = sensitivity ? levelsOf(sensitivity) : null;
  if (sensitivity && levels) {
    mapping.sensitivity = sensitivity.property!;
    mapping.features.sensitivity = levels;
    parts.push(sensitivity);
  }
  const wait = setting(exposes, "numeric", "occupancy_timeout");
  const range = wait ? rangeOf(wait) : null;
  const timed = timedByZigbee2mqtt.get(facts.model ?? "");
  if (wait && range) {
    mapping.clearAfter = { via: "device", property: wait.property! };
    mapping.features.clearAfter = range;
    parts.push(wait);
  } else if (timed) {
    mapping.clearAfter =
      timed.unset === "detectionInterval"
        ? { via: "option", unset: timed.unset, defaultInterval: timed.min }
        : { via: "option", unset: timed.unset };
    const blind =
      timed.unset === "detectionInterval"
        ? (facts.detectionInterval ?? timed.min)
        : timed.min;
    // When its blind time exceeds the offered range, no choice in that
    // range can take effect. Keep reading its wait without offering one.
    mapping.features.clearAfter =
      blind <= optionMax ? { min: blind, max: optionMax } : null;
  }
  const indicator = setting(
    exposes,
    "binary",
    "led_indication",
    "trigger_indicator",
  );
  if (indicator) {
    mapping.indicator = binaryOf(indicator);
    mapping.features.indicator = true;
    parts.push(indicator);
  }
  mapping.readable = parts
    .filter(
      (part) => part.access !== undefined && (part.access & access.get) !== 0,
    )
    .map((part) => part.property!);
  return mapping;
}

/** A sensor Zigbee2MQTT says no motion for, after its option. */
export type TimedOccupancyMapping = OccupancyMapping & {
  clearAfter: Extract<ClearAfterSetting, { via: "option" }>;
};

export function isTimedByZigbee2mqtt(
  mapping: OccupancyMapping,
): mapping is TimedOccupancyMapping {
  return mapping.clearAfter?.via === "option";
}

/** How long Zigbee2MQTT waits for a sensor it times, if that is known. */
export function timedClearAfter(
  setting: Extract<ClearAfterSetting, { via: "option" }>,
  timing: Timing,
) {
  if (setting.unset !== "detectionInterval") {
    return timing.option ?? setting.unset;
  }
  // Zigbee2MQTT's lumi_occupancy[_illuminance] converters ignore an
  // option below the detection interval, waiting that interval plus two
  // seconds when the option is absent or too short:
  // https://github.com/Koenkk/zigbee-herdsman-converters/blob/v26.115.1/src/lib/lumi.ts
  const interval = timing.detectionInterval ?? setting.defaultInterval;
  const seconds =
    timing.option !== undefined && timing.option >= interval
      ? timing.option
      : interval + 2;
  return secondsOf(seconds) ?? undefined;
}

/** The detection_interval a sensor's message says, in seconds. */
export function detectionIntervalOf(payload: Record<string, unknown>) {
  return secondsOf(payload.detection_interval);
}

/**
 * A motion sensor's state from its message, with the settings it says,
 * or null when it does not say whether it sees motion.
 */
export function occupancyState(
  mapping: OccupancyMapping,
  payload: Record<string, unknown>,
  timing: Timing = {},
): OccupancyState | null {
  const occupied = powerValue(payload[mapping.state.property], mapping.state);
  if (occupied === null) {
    return null;
  }
  const state: OccupancyState = { occupied };
  if (mapping.sensitivity) {
    const level = stringValue(payload[mapping.sensitivity]);
    const known = mapping.features.sensitivity?.find((each) => each === level);
    if (known) {
      state.sensitivity = known;
    }
  }
  const clearAfter =
    mapping.clearAfter?.via === "device"
      ? secondsOf(payload[mapping.clearAfter.property])
      : mapping.clearAfter
        ? timedClearAfter(mapping.clearAfter, timing)
        : undefined;
  if (clearAfter !== undefined && clearAfter !== null) {
    state.clearAfter = clearAfter;
  }
  if (mapping.indicator) {
    const indicator = powerValue(
      payload[mapping.indicator.property],
      mapping.indicator,
    );
    if (indicator !== null) {
      state.indicator = indicator;
    }
  }
  // Whatever a device sends, the core never gets a state it would refuse.
  return occupancy.state.safeParse(state).success ? state : null;
}

/**
 * What a command asks of a motion sensor: its own settings, to publish on
 * <device>/set, and the wait for Zigbee2MQTT's occupancy_timeout option
 * for a sensor it times.
 */
export function occupancyPayload(
  mapping: OccupancyMapping,
  command: OccupancyCommand,
): { set: Record<string, unknown>; option: number | null } {
  const set: Record<string, unknown> = {};
  let option: number | null = null;
  if (command.sensitivity !== undefined && mapping.sensitivity) {
    set[mapping.sensitivity] = command.sensitivity;
  }
  if (command.clearAfter !== undefined && mapping.clearAfter) {
    if (mapping.clearAfter.via === "device") {
      set[mapping.clearAfter.property] = command.clearAfter;
    } else {
      option = command.clearAfter;
    }
  }
  if (command.indicator !== undefined && mapping.indicator) {
    set[mapping.indicator.property] = command.indicator
      ? mapping.indicator.on
      : mapping.indicator.off;
  }
  return { set, option };
}
