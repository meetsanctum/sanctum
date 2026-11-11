import type { ButtonFeatures, LightFeatures } from "@meetsanctum/app-sdk";

import {
  mapOccupancy,
  type DeviceFacts,
  type OccupancyMapping,
} from "./occupancy.js";
import {
  isActionExpose,
  isHold,
  maxActions,
  pressActions,
  tapsAtRelease,
} from "./presses.js";
import { mapSensor, type SensorMapping } from "./sensors.js";
import { access, type ZigbeeExpose } from "./types.js";
import { numericValue } from "./values.js";

// A device's exposes onto the core's capability kinds, ported from v1's
// entityMappings and normalizedEntityCapabilities (zigbee2mqtt-model.ts,
// Pragmata v1-final). Lights, switches, a remote's buttons, a climate
// sensor's temperature and humidity and a motion sensor's light level
// (sensors.ts) and its occupancy with its settings (occupancy.ts): an expose
// of any other kind is left out rather than guessed at, and so is a light or
// switch that cannot be switched and an action expose with no presses. v1
// made a switch of a device with nothing it recognised; this driver brings
// no such device.

/** A binary feature, such as a light's state, and the values it takes. */
type Binary = { property: string; on: unknown; off: unknown };

type Mapped = {
  /** The capability's id in the core: the kind, or the endpoint, such as l1. */
  id: string;
  state: Binary;
  /** The properties Zigbee2MQTT can read again with /get. */
  readable: string[];
};

export type LightMapping = Mapped & {
  kind: "light";
  features: LightFeatures;
  // The properties that carry each feature, such as brightness_l1.
  brightness?: string;
  colorTemperature?: string;
  color?: string;
  colorMode: string;
};

export type SwitchMapping = Mapped & {
  kind: "switch";
  features: Record<string, never>;
};

/** A remote's buttons: the property its presses arrive in, and its actions. */
export type ButtonMapping = {
  kind: "button";
  id: string;
  property: string;
  features: ButtonFeatures;
  /** Presses said to the core at their release (presses.ts), the driver's own. */
  tapsAtRelease: string[];
  /** A press is over once it is said, so there is nothing to read again. */
  readable: [];
};

export type CapabilityMapping =
  | LightMapping
  | SwitchMapping
  | ButtonMapping
  | SensorMapping
  | OccupancyMapping;

// v1's colour temperature range when a light gives none.
const defaultColorTemperature = { min: 153, max: 500 };
// The range the light kind takes, in mireds.
const mireds = { min: 50, max: 1000 };

// A feature it can be told, unless Zigbee2MQTT says it cannot.
const settable = (feature: ZigbeeExpose) =>
  feature.access === undefined || (feature.access & access.set) !== 0;

const readable = (feature: ZigbeeExpose) =>
  feature.access !== undefined && (feature.access & access.get) !== 0;

function feature(expose: ZigbeeExpose, ...names: string[]) {
  return expose.features?.find(
    (each) => names.includes(each.name ?? "") && settable(each),
  );
}

// The capability id the core takes: short, lower case.
function capabilityId(expose: ZigbeeExpose, kind: string) {
  const id = (expose.endpoint ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 32);
  return id || kind;
}

function colorTemperatureRange(expose: ZigbeeExpose) {
  const min = numericValue(expose.value_min);
  const max = numericValue(expose.value_max);
  if (min === null || max === null) {
    return defaultColorTemperature;
  }
  const range = { min: Math.round(min), max: Math.round(max) };
  return range.min >= mireds.min &&
    range.max <= mireds.max &&
    range.min <= range.max
    ? range
    : defaultColorTemperature;
}

function mapButton(expose: ZigbeeExpose): ButtonMapping | null {
  const actions = pressActions(expose);
  return actions.length > 0
    ? {
        kind: "button",
        // A device's action exposes make one button (below), so its id
        // never needs the endpoint, which a switch there may have taken.
        id: "button",
        property: expose.property ?? "action",
        features: { actions, holds: actions.filter(isHold) },
        tapsAtRelease: tapsAtRelease(expose),
        readable: [],
      }
    : null;
}

function mapOne(
  expose: ZigbeeExpose,
  exposes: readonly ZigbeeExpose[],
  facts: DeviceFacts,
): CapabilityMapping | null {
  if (isActionExpose(expose)) {
    return mapButton(expose);
  }
  if (expose.type === "numeric") {
    return mapSensor(expose, exposes);
  }
  if (expose.type === "binary") {
    return mapOccupancy(expose, exposes, facts);
  }
  const kind = expose.type;
  if (kind !== "light" && kind !== "switch") {
    return null;
  }
  const state = feature(expose, "state");
  if (!state) {
    return null;
  }
  const property = state.property ?? "state";
  const mapped: Mapped = {
    id: capabilityId(expose, kind),
    state: {
      property,
      on: state.value_on ?? "ON",
      off: state.value_off ?? "OFF",
    },
    readable: [],
  };
  const parts = [state];
  if (kind === "switch") {
    mapped.readable = parts.filter(readable).map((part) => part.property!);
    return { ...mapped, kind, features: {} };
  }
  const brightness = feature(expose, "brightness");
  const colorTemperature = feature(expose, "color_temp");
  const color = feature(expose, "color_xy", "color_hs");
  parts.push(
    ...[brightness, colorTemperature, color].filter(
      (part) => part !== undefined,
    ),
  );
  mapped.readable = parts
    .filter((part) => readable(part) && part.property)
    .map((part) => part.property!);
  return {
    ...mapped,
    kind,
    features: {
      brightness: brightness !== undefined,
      colorTemperature: colorTemperature
        ? colorTemperatureRange(colorTemperature)
        : null,
      color: color !== undefined,
    },
    ...(brightness ? { brightness: brightness.property ?? "brightness" } : {}),
    ...(colorTemperature
      ? { colorTemperature: colorTemperature.property ?? "color_temp" }
      : {}),
    ...(color ? { color: color.property ?? "color" } : {}),
    // Its endpoint's colour mode, such as color_mode_l1 next to state_l1.
    colorMode: `color_mode${property.startsWith("state") ? property.slice("state".length) : ""}`,
  };
}

/**
 * The lights, switches, buttons, readings and motion a device exposes,
 * each once. Action exposes that publish in the same property are one
 * button, since a press says nothing of its endpoint and would otherwise
 * be handed on twice. A motion sensor's settings depend on its model and
 * what it said (`facts`).
 */
export function capabilityMappings(
  exposes: readonly ZigbeeExpose[],
  facts: DeviceFacts = {},
): CapabilityMapping[] {
  const mappings: CapabilityMapping[] = [];
  for (const expose of exposes) {
    const mapping = mapOne(expose, exposes, facts);
    if (!mapping) {
      continue;
    }
    const button =
      mapping.kind === "button"
        ? mappings.find(
            (each): each is ButtonMapping =>
              each.kind === "button" && each.property === mapping.property,
          )
        : undefined;
    if (button && mapping.kind === "button") {
      const actions = [
        ...new Set([...button.features.actions, ...mapping.features.actions]),
      ].slice(0, maxActions);
      button.features = { actions, holds: actions.filter(isHold) };
      button.tapsAtRelease = [
        ...new Set([...button.tapsAtRelease, ...mapping.tapsAtRelease]),
      ].filter((action) => actions.includes(action));
    } else if (!mappings.some((each) => each.id === mapping.id)) {
      mappings.push(mapping);
    }
  }
  return mappings;
}
