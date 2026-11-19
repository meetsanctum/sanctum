import type {
  CapabilityInfo,
  DeviceInfo,
  LightState,
  Places,
  SyncStatus,
} from "@meetsanctum/app-sdk";
import { deviceTypeOf } from "@meetsanctum/app-sdk";

// Devices and capabilities for the tiles' tests.

export const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  rooms: [
    { id: "living", name: "Living room", floorId: null },
    { id: "kitchen", name: "Kitchen", floorId: null },
  ],
  zones: [],
};

export function light(
  state: LightState | null,
  sync: SyncStatus = "synced",
): CapabilityInfo {
  return {
    id: "light",
    kind: "light",
    features: { brightness: true, colorTemperature: null, color: false },
    state,
    observed: state,
    desired: null,
    sync,
    setBy: null,
    changedAt: null,
  };
}

export function plug(id: string, on: boolean): CapabilityInfo {
  const state = { on };
  return {
    id,
    kind: "switch",
    features: {},
    state,
    observed: state,
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt: null,
  };
}

export function device(
  id: string,
  name: string,
  roomId: string | null,
  capabilities: CapabilityInfo[],
  availability: DeviceInfo["availability"] = "online",
): DeviceInfo {
  return {
    id,
    name,
    driverName: name,
    type: deviceTypeOf(capabilities.map((each) => each.kind)),
    driver: "sanctum.zigbee",
    manufacturer: null,
    model: null,
    roomId,
    availability,
    lastSeenAt: null,
    firmware: null,
    probe: false,
    identify: false,
    battery: null,
    batteryLow: null,
    shownAs: null,
    leftAt: null,
    problem: null,
    capabilities,
  };
}

// A remote with a button and nothing to switch.
export function remote(id: string, name: string, roomId: string | null) {
  return device(id, name, roomId, [
    {
      id: "button",
      kind: "button",
      features: { actions: ["single", "double", "hold"], holds: [] },
      state: null,
      observed: null,
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    },
  ]);
}

export function reading(
  measure: "temperature" | "humidity" | "illuminance",
  value: number | null,
): CapabilityInfo {
  const state = value === null ? null : { value };
  return {
    id: measure,
    kind: "sensor",
    features: { measures: measure },
    state,
    observed: state,
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt: null,
  };
}

export const climate = (
  id: string,
  roomId: string | null,
  temperature: number | null,
  humidity: number | null,
  availability: DeviceInfo["availability"] = "online",
) =>
  device(
    id,
    `${id} sensor`,
    roomId,
    [reading("temperature", temperature), reading("humidity", humidity)],
    availability,
  );

export function motionCapability(
  motion: boolean | null,
  changedAt: string | null = null,
): CapabilityInfo {
  const state = motion === null ? null : { motion };
  return {
    id: "occupancy",
    kind: "motion",
    features: {
      sensitivity: null,
      clearAfter: null,
      indicator: false,
    },
    state,
    observed: state,
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt,
  };
}
