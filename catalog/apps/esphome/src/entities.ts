import type { DeviceRegistration, MediaPlayback } from "@meetsanctum/app-sdk";
import { ColorMode, EntityCategory, type Entity } from "esphome-client";

// What a device's entities are in Sanctum: the capabilities they map onto,
// and the rest by name, which its page lists as what Sanctum can't use yet.
// A device's diagnostic and configuration entities, such as its Wi-Fi
// signal, are its own, never capabilities.

type Capability = DeviceRegistration["capabilities"][number];

// A colour mode's parts, as ESPHome's ColorMode numbers them bit by bit.
const brightnessBit = 2;
const temperatureBits = 8 | 16;
const colorBit = 32;

// The kinds of binary sensor Sanctum reads, by ESPHome's device class. A
// motion sensor's "no motion" is left to the device, and presence and
// occupancy, as from mmWave radar, are motion until Sanctum has a kind of
// its own for them.
const motionClasses = new Set(["motion", "occupancy", "presence"]);
const contactClasses = new Set(["door", "window", "opening", "garage_door"]);

// What a sensor measures, by ESPHome's device class, with the units each
// may come in.
const measures = {
  temperature: new Set(["°C", "°F", "K"]),
  humidity: new Set(["%"]),
  illuminance: new Set(["lx"]),
} as const;
type Measure = keyof typeof measures;

/** One of a device's entities as Sanctum takes it. */
export type Mapped = {
  capability: Capability;
  entity: Entity;
};

/** What a device's entities give Sanctum, and what they don't. */
export type Mapping = {
  mapped: Mapped[];
  /** The other entities' names, as the device calls them, in its order. */
  unused: string[];
};

// A capability's id from its entity's, stable while the entity keeps its
// name: the entity's type and object id, within 32 characters, which its
// key, a hash of that id, keeps apart when cut short.
export function capabilityIdOf(entity: Entity) {
  const prefix = {
    light: "light",
    switch: "switch",
    sensor: "sensor",
    binary_sensor: "binary",
    event: "event",
    media_player: "media",
  }[entity.type as string];
  const id = `${prefix ?? entity.type}-${entity.objectId}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  if (id.length <= 32) return id;
  const key = (entity.key >>> 0).toString(16).padStart(8, "0");
  return `${id.slice(0, 23)}-${key}`;
}

/** The modes a light has, as ESPHome lists them. */
export function colorModesOf(entity: Entity): number[] {
  return entity.type === "light"
    ? [...(entity.supportedColorModes ?? [])].filter(
        (mode) => mode !== ColorMode.UNKNOWN,
      )
    : [];
}

function lightCapability(entity: Entity & { type: "light" }): Capability {
  const modes = colorModesOf(entity);
  const has = (bits: number) => modes.some((mode) => (mode & bits) !== 0);
  const min = Math.round(entity.minMireds ?? 0);
  const max = Math.round(entity.maxMireds ?? 0);
  const range =
    has(temperatureBits) && min >= 50 && max <= 1000 && min <= max
      ? { min, max }
      : null;
  return {
    id: capabilityIdOf(entity),
    kind: "light",
    features: {
      brightness: has(brightnessBit),
      colorTemperature: range,
      color: has(colorBit),
    },
  };
}

/** What a sensor measures in Sanctum, or null for one it doesn't read. */
export function measureOf(entity: Entity): Measure | null {
  if (entity.type !== "sensor") return null;
  const measure = entity.deviceClass as Measure | undefined;
  if (!measure || !Object.hasOwn(measures, measure)) return null;
  const unit = entity.unitOfMeasurement ?? "";
  return (measures[measure] as Set<string>).has(unit) ? measure : null;
}

// ESPHome's media player feature bits. Power requires both commands.
const pause = 1 << 0;
const power = (1 << 7) | (1 << 8);
const play = 1 << 14;

// A press whose name says nobody sets it on purpose, as the Home Assistant
// Voice PE's easter egg.
const hiddenActions = new Set(["easter_egg_press"]);

function capabilityOf(entity: Entity): Capability | null {
  const id = capabilityIdOf(entity);
  switch (entity.type) {
    case "light":
      return lightCapability(entity);
    case "switch":
      return { id, kind: "switch", features: {} };
    case "sensor": {
      const measure = measureOf(entity);
      return measure
        ? { id, kind: "sensor", features: { measures: measure } }
        : null;
    }
    case "binary_sensor": {
      const deviceClass = entity.deviceClass ?? "";
      if (motionClasses.has(deviceClass)) {
        return {
          id,
          kind: "motion",
          features: { sensitivity: null, clearAfter: null, indicator: false },
        };
      }
      return contactClasses.has(deviceClass)
        ? { id, kind: "contact", features: {} }
        : null;
    }
    case "event": {
      const actions = [...new Set(entity.eventTypes ?? [])].filter(
        (action) =>
          /^[A-Za-z0-9][\w.:-]{0,63}$/.test(action) &&
          !hiddenActions.has(action),
      );
      return actions.length > 0
        ? {
            id,
            kind: "button",
            features: { actions: actions.slice(0, 64), holds: [] },
          }
        : null;
    }
    case "media_player": {
      // Older firmware reported Play and Pause together as supportsPause.
      const flags =
        entity.featureFlags ?? (entity.supportsPause ? play | pause : 0);
      const playback: MediaPlayback[] = [];
      if (flags & play) playback.push("play");
      if (flags & pause) playback.push("pause");
      playback.push("stop");
      return {
        id,
        kind: "media",
        features: {
          power: (flags & power) === power,
          playback,
          volume: "level",
          mute: true,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * A device's entities as Sanctum takes them: its everyday ones mapped onto
 * capabilities, at most 32, and the rest by name.
 */
export function mapEntities(entities: readonly Entity[]): Mapping {
  const mapped: Mapped[] = [];
  const unused: string[] = [];
  const ids = new Set<string>();
  for (const entity of entities) {
    // Its own settings and readings about itself are for its page only.
    const ownPart =
      entity.entityCategory === EntityCategory.DIAGNOSTIC ||
      entity.entityCategory === EntityCategory.CONFIG;
    const capability = ownPart ? null : capabilityOf(entity);
    if (capability && !ids.has(capability.id) && mapped.length < 32) {
      ids.add(capability.id);
      mapped.push({ capability, entity });
    } else if (
      (!ownPart || entity.type !== "sensor") &&
      // What it hides by default, it rarely needs.
      entity.disabledByDefault !== true
    ) {
      unused.push(entity.name);
    }
  }
  return { mapped, unused };
}

/** Its Wi-Fi signal's entity, a diagnostic sensor in dBm, where it has one. */
export function signalOf(entities: readonly Entity[]) {
  return (
    entities.find(
      (entity) =>
        entity.type === "sensor" &&
        entity.deviceClass === "signal_strength" &&
        entity.unitOfMeasurement === "dBm",
    ) ?? null
  );
}
