import type { FirmwareState } from "@meetsanctum/app-sdk";

import type { ZigbeeDevice } from "./types.js";
import { isRecord, numericValue, stringValue } from "./values.js";

// Firmware over the air, as Zigbee2MQTT 2 describes it, onto the Drivers
// contract's firmware states. Zigbee2MQTT checks for an update by itself
// whenever a device asks for one, at most once a day, and publishes what it
// knows as the device state's `update`: its state, and while it updates its
// progress and the seconds it has left.

/** What a device's firmware is doing, as the driver tells the core. */
export type FirmwareSaid = {
  state: FirmwareState;
  progress: number | null;
  remainingSeconds: number | null;
};

const said = (state: FirmwareState): FirmwareSaid => ({
  state,
  progress: null,
  remainingSeconds: null,
});

/**
 * What a device state's `update` says of its firmware, or null when it says
 * nothing the driver knows. `scheduled` waits for the device to wake. An
 * `idle` device whose latest version is newer than the one it runs still
 * has that update available: Zigbee2MQTT says idle after it restarts
 * during an update.
 */
export function firmwareOf(update: unknown): FirmwareSaid | null {
  if (!isRecord(update)) {
    return null;
  }
  switch (stringValue(update.state)?.toLowerCase()) {
    case "available":
      return said("available");
    case "scheduled":
      return said("waiting");
    case "updating": {
      const progress = numericValue(update.progress);
      const remaining = numericValue(update.remaining);
      return {
        state: "updating",
        progress:
          progress === null ? null : Math.min(100, Math.max(0, progress)),
        remainingSeconds:
          remaining === null ? null : Math.max(0, Math.round(remaining)),
      };
    }
    case "idle": {
      const installed = numericValue(update.installed_version);
      const latest = numericValue(update.latest_version);
      return said(
        installed !== null && latest !== null && latest > installed
          ? "available"
          : "current",
      );
    }
    default:
      return null;
  }
}

/** What a device runs, as Zigbee2MQTT lists it: its software build, else its date code. */
export function versionOf(device: ZigbeeDevice) {
  const version =
    stringValue(device.software_build_id) ?? stringValue(device.date_code);
  return version?.trim().slice(0, 120).trim() || null;
}

/**
 * Words for people from why Zigbee2MQTT says an update failed, such as
 * "OTA update of 'Office light' failed (Device didn't respond to OTA
 * request)".
 */
export function problemOf(error: string) {
  if (/respond|answer|timed? ?out|unreachable/i.test(error)) {
    return "It stopped answering.";
  }
  if (/no image|not available/i.test(error)) {
    return "No update is available for it any more.";
  }
  return "The update did not finish.";
}

/**
 * Whether the driver tells the core about a device's progress now: always
 * when the state changes, and while it updates once a whole percent has
 * passed and a few seconds since it last did, so a long update does not
 * flood the core and every client. Zigbee2MQTT repeats a device's last
 * `update` with every message it publishes, so that is never a sign of
 * life by itself; the bridge's heartbeat says an update is still under way.
 */
export function isWorthSaying(
  last: (FirmwareSaid & { at: number }) | undefined,
  next: FirmwareSaid,
  at: number,
  everyMs = 5_000,
) {
  if (!last || last.state !== next.state) {
    return true;
  }
  if (next.state !== "updating") {
    return false;
  }
  const moved =
    Math.floor(next.progress ?? 0) !== Math.floor(last.progress ?? 0);
  return moved && (at - last.at >= everyMs || next.progress === 100);
}
