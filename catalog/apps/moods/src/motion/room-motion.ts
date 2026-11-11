import type { CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";

// What motion may do to a room's lights, and the room's motion and light
// sensors, for Moods' actions and its pages alike, so it imports nothing
// at run time (as targets.ts).

/** The light levels, in lux, below which motion may turn a room's lights on. */
export const darkerThanChoices = [5, 10, 30, 50, 100, 200] as const;
export type DarkerThan = (typeof darkerThanChoices)[number];

/** The minutes with no motion after which a room's lights may turn off. */
export const turnOffAfterChoices = [2, 5, 10, 15, 30, 60] as const;
export type TurnOffAfter = (typeof turnOffAfterChoices)[number];

/** How long with no motion a switch turned on starts with. */
export const defaultTurnOffAfter: TurnOffAfter = 10;

/**
 * What motion does to a room's lights: whether it turns them on, only
 * while the room is darker than a light level if one is chosen, and after
 * how many minutes with no motion they turn off, none leaving them on.
 */
export type RoomMotion = {
  roomId: string;
  turnOn: boolean;
  darkerThan: number | null;
  turnOffAfter: number | null;
};

/** A change to what motion does, the rest left as it is. */
export type MotionChange = {
  turnOn?: boolean;
  darkerThan?: DarkerThan | null;
  turnOffAfter?: TurnOffAfter | null;
};

/** A room where motion does nothing, as every room starts. */
export const stillRoom = (roomId: string): RoomMotion => ({
  roomId,
  turnOn: false,
  darkerThan: null,
  turnOffAfter: null,
});

type Sensor = Extract<CapabilityInfo, { kind: "sensor" }>;

/** Whether a capability reads the light level, in lux. */
export function readsLightLevel(
  capability: CapabilityInfo,
): capability is Sensor {
  return (
    capability.kind === "sensor" &&
    capability.features.measures === "illuminance"
  );
}

/** The devices in a room that see motion, offline or not. */
export function motionSensorsIn(
  devices: readonly DeviceInfo[],
  roomId: string,
): DeviceInfo[] {
  return devices.filter(
    (device) =>
      device.roomId === roomId &&
      device.capabilities.some((capability) => capability.kind === "occupancy"),
  );
}

/** The devices in a room that read its light level, offline or not. */
export function lightSensorsIn(
  devices: readonly DeviceInfo[],
  roomId: string,
): DeviceInfo[] {
  return devices.filter(
    (device) =>
      device.roomId === roomId && device.capabilities.some(readsLightLevel),
  );
}

/**
 * A room's light level now, in lux, as the core's light-level condition
 * reads it: the highest any of its sensors that answer reads, or null while
 * none does.
 */
export function lightLevelIn(
  devices: readonly DeviceInfo[],
  roomId: string,
): number | null {
  const levels = lightSensorsIn(devices, roomId)
    .filter((device) => device.availability !== "offline")
    .flatMap((device) =>
      device.capabilities.flatMap((capability) =>
        readsLightLevel(capability) && capability.observed
          ? [capability.observed.value]
          : [],
      ),
    );
  return levels.length > 0 ? Math.max(...levels) : null;
}
