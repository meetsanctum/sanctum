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

/** Whether a device runs on a battery: it has said its charge, or its driver says it sleeps, as one on a battery does. */
export function onBattery(device: Pick<DeviceInfo, "battery" | "firmware">) {
  return device.battery !== null || device.firmware?.sleeps === true;
}

/**
 * What a device needs from the household, the most pressing first: `quiet`,
 * on a battery and not heard from for a day; `battery`, its charge under
 * `lowBattery`; or `update`, firmware to start, under way, waiting for it to
 * wake or that didn't finish. Null when it needs nothing.
 */
export type Maintenance = "quiet" | "battery" | "update";

export function maintenanceOf(
  device: Pick<
    DeviceInfo,
    "availability" | "lastSeenAt" | "battery" | "firmware"
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
  if (device.battery !== null && device.battery < lowBattery) return "battery";
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
