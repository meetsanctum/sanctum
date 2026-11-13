import type { CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";

// The lights in a room, for Moods' actions and its pages alike, so it
// imports nothing at run time.

export type LightCapability = Extract<CapabilityInfo, { kind: "light" }>;
export type Light = { device: DeviceInfo; capability: LightCapability };

/** The lights in a room that a command can reach. */
export function lightsInRoom(
  devices: readonly DeviceInfo[],
  roomId: string,
): Light[] {
  return allLightsInRoom(
    devices.filter((device) => device.availability !== "offline"),
    roomId,
  );
}

/** Every light in a room, offline or not, as what turning it on names. */
export function allLightsInRoom(
  devices: readonly DeviceInfo[],
  roomId: string,
): Light[] {
  return devices
    .filter((device) => device.roomId === roomId)
    .flatMap((device) =>
      device.capabilities
        .filter((capability) => capability.kind === "light")
        .map((capability) => ({ device, capability })),
    );
}
