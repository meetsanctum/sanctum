import type {
  SensorFeatures,
  SensorMeasure,
  SensorState,
} from "@meetsanctum/app-sdk";

import { access, type ZigbeeExpose } from "./types.js";
import { numericValue } from "./values.js";

// A climate sensor's readings, a motion sensor's light level and a
// device's battery, as Zigbee2MQTT publishes them. v1 made a sensor entity
// of every numeric expose and then sorted the diagnostics out by name
// (battery, link quality, voltage, a chip's own temperature); here only
// the room's readings become `sensor` capabilities, by their exact
// property, so a plug's device_temperature or a thermostat's
// local_temperature never passes for a room's. The light level is in lux:
// Zigbee2MQTT 1.x says it as illuminance_lux beside a raw illuminance, 2.x
// as illuminance in lx; a raw reading, a dim-or-bright illumination and
// IKEA's illuminance_above_threshold are not one. The battery is the
// device's own, so it goes into the report rather than a capability.

export type SensorMapping = {
  kind: "sensor";
  /** The capability's id in the core: what it measures. */
  id: SensorMeasure;
  property: string;
  features: SensorFeatures;
  /** Whether the device says it in Fahrenheit, which the core takes in Celsius. */
  fahrenheit: boolean;
  /** The properties Zigbee2MQTT can read again with /get. */
  readable: string[];
};

// What each reading is called in a device's state.
const measures: Record<string, SensorMeasure> = {
  temperature: "temperature",
  humidity: "humidity",
  illuminance: "illuminance",
  illuminance_lux: "illuminance",
};

// What a room can read, in each measure's standard unit; anything else is
// a glitch, such as the 0 or -100 some sensors say as they start. Full
// sunlight is about 100,000 lux.
const plausible: Record<SensorMeasure, { min: number; max: number }> = {
  temperature: { min: -50, max: 100 },
  humidity: { min: 0, max: 100 },
  illuminance: { min: 0, max: 200_000 },
};

// Whether an expose says the light level in lux: illuminance_lux whenever
// the device has it, its illuminance only in lx and without one.
function isLux(expose: ZigbeeExpose, exposes: readonly ZigbeeExpose[]) {
  if (expose.property === "illuminance_lux") {
    return true;
  }
  return (
    expose.unit?.trim() === "lx" &&
    !exposes.some((each) => each.property === "illuminance_lux")
  );
}

/**
 * A reading the device publishes, such as its temperature; null for any
 * other expose. `exposes` are all of the device's, which say whether its
 * illuminance is in lux.
 */
export function mapSensor(
  expose: ZigbeeExpose,
  exposes: readonly ZigbeeExpose[] = [expose],
): SensorMapping | null {
  const measure = measures[expose.property ?? ""];
  if (
    expose.type !== "numeric" ||
    !measure ||
    (measure === "illuminance" && !isLux(expose, exposes)) ||
    (expose.access !== undefined && (expose.access & access.state) === 0)
  ) {
    return null;
  }
  return {
    kind: "sensor",
    id: measure,
    property: expose.property!,
    features: { measures: measure },
    fahrenheit:
      measure === "temperature" && /^°?f$/i.test(expose.unit?.trim() ?? ""),
    readable:
      expose.access !== undefined && (expose.access & access.get) !== 0
        ? [expose.property!]
        : [],
  };
}

/** A reading from a device's message, or null when it says none the core can take. */
export function sensorState(
  mapping: SensorMapping,
  payload: Record<string, unknown>,
): SensorState | null {
  const said = numericValue(payload[mapping.property]);
  if (said === null) {
    return null;
  }
  const value = mapping.fahrenheit
    ? Math.round(((said - 32) * 5 * 100) / 9) / 100
    : said;
  const { min, max } = plausible[mapping.id];
  return value >= min && value <= max ? { value } : null;
}

/** A device's battery charge in percent, as its message says it. */
export function batteryOf(payload: Record<string, unknown>) {
  const battery = numericValue(payload.battery);
  return battery !== null && battery >= 0 && battery <= 100
    ? Math.round(battery)
    : undefined;
}
