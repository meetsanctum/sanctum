import {
  hasLowBattery,
  lowCharge,
  maintenanceOf,
  onBattery,
  type DeviceInfo,
  type FirmwareState,
} from "@meetsanctum/app-sdk";
import {
  calendarDaysBetween,
  type HomeClock,
} from "@meetsanctum/app-sdk/clock";

import { compare, plural } from "@meetsanctum/app-sdk/words";

// Maintenance: what the home's devices need from the household, as Settings,
// its Maintenance page, the dashboard's Batteries tile and a device's own
// line and tile say it: a device on a battery gone quiet, a low battery, and
// firmware to update.

/** When a device was last heard from, as "since …" says it: yesterday, a weekday this week, or a date. */
export function sinceWords(clock: HomeClock, at: string, now: number) {
  const then = Date.parse(at);
  const days = calendarDaysBetween(then, now, clock.timeZone);
  if (days <= 1) return "yesterday";
  return days < 7 ? clock.longWeekdayText(then) : clock.longDayText(then);
}

/** What leads a quiet device's line. */
export function quietText(clock: HomeClock, device: DeviceInfo, now: number) {
  return `Not heard from since ${sinceWords(clock, device.lastSeenAt!, now)}: try a new battery`;
}

/**
 * What leads a line with a low battery, with its charge (`lowCharge`) or
 * without it: where the charge sits beside it, and where the device says
 * its battery is low at a charge that isn't, or without one.
 */
export function lowBatteryText(battery?: number) {
  return battery === undefined
    ? "Battery low: replace it soon"
    : `Battery low, ${battery}%: replace it soon`;
}

const byName = (a: DeviceInfo, b: DeviceInfo) => compare("en")(a.name, b.name);

/**
 * Every device on a battery, the next to replace first: quiet ones, the
 * longest quiet first, then those with a low battery, then the rest, each
 * by charge, lowest first, and last those that have not said it.
 */
export function batteryOrder(devices: readonly DeviceInfo[], now: number) {
  const quiet = (device: DeviceInfo) => maintenanceOf(device, now) === "quiet";
  return devices.filter(onBattery).sort((a, b) => {
    if (quiet(a) !== quiet(b)) return quiet(a) ? -1 : 1;
    if (quiet(a)) {
      return Date.parse(a.lastSeenAt!) - Date.parse(b.lastSeenAt!);
    }
    if (hasLowBattery(a) !== hasLowBattery(b)) {
      return hasLowBattery(a) ? -1 : 1;
    }
    if (a.battery !== b.battery) {
      if (a.battery === null) return 1;
      if (b.battery === null) return -1;
      return a.battery - b.battery;
    }
    return byName(a, b);
  });
}

/** The batteries to replace: quiet devices and low batteries, in batteryOrder. */
export function dueBatteries(devices: readonly DeviceInfo[], now: number) {
  return batteryOrder(devices, now).filter((device) => {
    const need = maintenanceOf(device, now);
    return need === "quiet" || need === "battery";
  });
}

const updateOrder: Partial<Record<FirmwareState, number>> = {
  failed: 0,
  updating: 1,
  waiting: 2,
  available: 3,
};

/** Devices with an update to start, under way, waiting or that didn't finish, in that order. */
export function updatesOf(devices: readonly DeviceInfo[]) {
  const rank = (device: DeviceInfo) =>
    updateOrder[device.firmware?.state ?? "current"];
  return devices
    .filter((device) => rank(device) !== undefined)
    .sort((a, b) => rank(a)! - rank(b)! || byName(a, b));
}

/** Settings' row for Maintenance: how many batteries to replace and updates, if any. */
export function maintenanceHint(devices: readonly DeviceInfo[], now: number) {
  const batteries = dueBatteries(devices, now).length;
  const updates = updatesOf(devices).length;
  return (
    [
      batteries
        ? plural("en", batteries, { one: "# battery", other: "# batteries" })
        : null,
      updates
        ? plural("en", updates, { one: "# update", other: "# updates" })
        : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined
  );
}

/** What the dashboard's Batteries tile says, while a battery is to replace: one device by its name, several by their number. */
export function batteriesTile(
  clock: HomeClock,
  devices: readonly DeviceInfo[],
  now: number,
) {
  const due = dueBatteries(devices, now);
  const said = (device: DeviceInfo) =>
    maintenanceOf(device, now) === "quiet"
      ? `${device.name} hasn't been heard from since ${sinceWords(clock, device.lastSeenAt!, now)}`
      : lowCharge(device) === undefined
        ? `${device.name}'s battery is low`
        : `${device.name}'s battery is at ${device.battery}%`;
  const [only] = due;
  if (!only) return null;
  if (due.length === 1) {
    const isQuiet = maintenanceOf(only, now) === "quiet";
    const charge = lowCharge(only);
    return {
      title: only.name,
      // Short enough for a 1 × 2 tile, as the activity log says it.
      value: isQuiet
        ? "Gone quiet"
        : charge === undefined
          ? "Battery low"
          : `Battery ${charge}%`,
      label: isQuiet
        ? `${said(only)}. Its battery may be empty. Opens Maintenance`
        : `${only.name}'s battery is low${charge === undefined ? "" : `, ${charge}%`}. Opens Maintenance`,
    };
  }
  return {
    title: "Batteries",
    // Short enough for a 1 × 2 tile.
    value: `Replace ${due.length}`,
    label: `Batteries, replace ${due.length}: ${due.map(said).join(", ")}. Opens Maintenance`,
  };
}
