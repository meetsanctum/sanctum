import type { DeviceInfo } from "./devices.js";

/**
 * The charge below which a device's battery is low, in percent: Zigbee
 * devices still run a good while at 20%.
 */
export const lowBattery = 10;

/**
 * How long a device on a battery goes unheard before it counts as quiet,
 * once its driver no longer knows whether it answers, as Zigbee2MQTT says
 * of one after 25 hours: its battery is likely empty.
 */
export const quietAfterMs = 24 * 60 * 60_000;

/** Whether a device runs on a battery: it has said its charge or that its battery is low, or its driver says it sleeps, as one on a battery does. */
export function onBattery(
  device: Pick<DeviceInfo, "battery" | "batteryLow" | "firmware">,
) {
  return (
    device.battery !== null ||
    device.batteryLow ||
    device.firmware?.sleeps === true
  );
}

/**
 * Whether a device's battery is low: its charge is under `lowBattery`, or
 * the device says so itself, whatever its charge.
 */
export function hasLowBattery(
  device: Pick<DeviceInfo, "battery" | "batteryLow">,
) {
  return (
    device.batteryLow ||
    (device.battery !== null && device.battery < lowBattery)
  );
}

/**
 * The charge to say beside a low battery: the device's own while it is
 * under `lowBattery`, and none where the device says its battery is low at
 * a charge that isn't, or without one.
 */
export function lowCharge(device: Pick<DeviceInfo, "battery">) {
  return device.battery !== null && device.battery < lowBattery
    ? device.battery
    : undefined;
}

/**
 * What a device needs from the household, the most pressing first: `quiet`,
 * on a battery and not heard from for a day; `battery`, its battery low
 * (`hasLowBattery`); or `update`, firmware to start, under way, waiting for it to
 * wake or that didn't finish. Null when it needs nothing.
 */
export type Maintenance = "quiet" | "battery" | "update";

export function maintenanceOf(
  device: Pick<
    DeviceInfo,
    "availability" | "lastSeenAt" | "battery" | "batteryLow" | "firmware"
  >,
  now: number,
): Maintenance | null {
  if (
    onBattery(device) &&
    device.availability === "unknown" &&
    device.lastSeenAt !== null &&
    now - Date.parse(device.lastSeenAt) >= quietAfterMs
  ) {
    return "quiet";
  }
  if (hasLowBattery(device)) return "battery";
  const state = device.firmware?.state;
  return state && state !== "current" ? "update" : null;
}

/**
 * Why a device needs someone, the most pressing first: its network no longer
 * has it, its driver says something is wrong with it, it stopped answering,
 * or it is in no room yet. Upkeep, such as a battery to replace, is not
 * among them.
 */
export type AttentionReason = "left" | "problem" | "offline" | "room";

/**
 * What a device needs someone to do, the most pressing first, or nothing.
 * A device in no room needs one only while the home has rooms; until then
 * the setup guide asks for them. One that left its network needs nothing
 * else: whoever deals with it removes it or adds it again. A device that
 * sleeps is never offline, only unknown, so it never counts as offline.
 */
export function attentionOf(
  device: DeviceInfo,
  homeHasRooms: boolean,
): AttentionReason[] {
  if (device.leftAt !== null) return ["left"];
  const reasons: AttentionReason[] = [];
  if (device.problem) reasons.push("problem");
  if (device.availability === "offline") reasons.push("offline");
  if (homeHasRooms && device.roomId === null) reasons.push("room");
  return reasons;
}
