import type {
  CapabilityInfo,
  DeviceInfo,
  LightFeatures,
  LightState,
  Places,
} from "@meetsanctum/app-sdk";

import type { Light, LightCapability } from "../../src/targets.js";

// A home for the moods' tests: an office and a kitchen, and lights, motion
// sensors and light sensors built as the core shows them.

export const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  rooms: [
    { id: "office", name: "Office", floorId: null },
    { id: "kitchen", name: "Kitchen", floorId: null },
  ],
  zones: [],
};

const dimmable: LightFeatures = {
  brightness: true,
  colorTemperature: null,
  color: false,
};

export function lightCapability(
  state: LightState | null,
  options: {
    features?: Partial<LightFeatures>;
    sync?: CapabilityInfo["sync"];
    desired?: Partial<LightState>;
  } = {},
): LightCapability {
  return {
    id: "light",
    kind: "light",
    features: { ...dimmable, ...options.features },
    state,
    observed: state,
    desired: options.desired ?? null,
    sync: options.sync ?? "synced",
    setBy: null,
    changedAt: null,
  };
}

export function device(
  id: string,
  roomId: string | null,
  capabilities: CapabilityInfo[],
  availability: DeviceInfo["availability"] = "online",
): DeviceInfo {
  return {
    id,
    name: id,
    driverName: id,
    driver: "sanctum.zigbee",
    manufacturer: null,
    model: null,
    roomId,
    availability,
    lastSeenAt: null,
    firmware: null,
    probe: false,
    battery: null,
    leftAt: null,
    capabilities,
  };
}

/** One light, as lightsInRoom gives it. */
export function light(
  id: string,
  state: LightState | null,
  options: Parameters<typeof lightCapability>[1] & { room?: string } = {},
): Light {
  const capability = lightCapability(state, options);
  return {
    device: device(id, options.room ?? "office", [capability]),
    capability,
  };
}

/** A motion sensor's occupancy, seeing someone or not; null before its first report. */
export function occupancyCapability(occupied: boolean | null): CapabilityInfo {
  const state = occupied === null ? null : { occupied };
  return {
    id: "occupancy",
    kind: "occupancy",
    features: {
      senses: "motion",
      sensitivity: null,
      clearAfter: null,
      indicator: false,
    },
    state,
    observed: state,
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt: null,
  };
}

/** A sensor reading the light level in lux; null before its first report. */
export function illuminanceCapability(lux: number | null): CapabilityInfo {
  const state = lux === null ? null : { value: lux };
  return {
    id: "illuminance",
    kind: "sensor",
    features: { measures: "illuminance" },
    state,
    observed: state,
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt: null,
  };
}
