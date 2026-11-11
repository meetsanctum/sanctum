import {
  maintenanceOf,
  onBattery,
  type DeviceInfo,
  type FirmwareState,
} from "@meetsanctum/app-sdk";

// Maintenance: what the home's devices need from the household, as Settings,
// its Maintenance page, the dashboard's Batteries tile and a device's own
// line and tile say it: a device on a battery gone quiet, a low battery, and
// firmware to update.

const dayMs = 24 * 60 * 60_000;

const plural = (count: number, one: string, several = `${one}s`) =>
  `${count} ${count === 1 ? one : several}`;

function startOfDay(at: number) {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** When a device was last heard from, as "since …" says it: yesterday, a weekday this week, or a date. */
export function sinceWords(at: string, now: number) {
  const then = Date.parse(at);
  const days = Math.round((startOfDay(now) - startOfDay(then)) / dayMs);
  if (days <= 1) return "yesterday";
  return new Date(then).toLocaleDateString(
    "en-GB",
    days < 7 ? { weekday: "long" } : { day: "numeric", month: "long" },
  );
}

/** What leads a quiet device's line. */
export function quietText(device: DeviceInfo, now: number) {
  return `Not heard from since ${sinceWords(device.lastSeenAt!, now)}: try a new battery`;
}

/** What leads a line with a low battery, with its charge or without it where the charge sits beside it. */
export function lowBatteryText(battery?: number) {
  return battery === undefined
    ? "Battery low: replace it soon"
    : `Battery low, ${battery}%: replace it soon`;
}

const byName = (a: DeviceInfo, b: DeviceInfo) => a.name.localeCompare(b.name);

/**
 * Every device on a battery, the next to replace first: quiet ones, the
 * longest quiet first, then by charge, lowest first, and last those that
 * have not said it yet.
 */
export function batteryOrder(devices: readonly DeviceInfo[], now: number) {
  const quiet = (device: DeviceInfo) => maintenanceOf(device, now) === "quiet";
  return devices.filter(onBattery).sort((a, b) => {
    if (quiet(a) !== quiet(b)) return quiet(a) ? -1 : 1;
    if (quiet(a)) {
      return Date.parse(a.lastSeenAt!) - Date.parse(b.lastSeenAt!);
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

/** Maintenance's heading hint: how many batteries to replace and updates, if any. */
export function maintenanceHint(devices: readonly DeviceInfo[], now: number) {
  const batteries = dueBatteries(devices, now).length;
  const updates = updatesOf(devices).length;
  return (
    [
      batteries ? plural(batteries, "battery", "batteries") : null,
      updates ? plural(updates, "update") : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined
  );
}

/** A few names, such as "Office light and Hall light" or "Desk lamp, Office light and 2 more". */
export function namesOf(devices: readonly DeviceInfo[]) {
  const names = devices.map((device) => device.name);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** The line of Settings' row for updates: the one that leads, then the rest. */
export function updatesLine(updates: readonly DeviceInfo[]) {
  const [first, ...rest] = updates;
  if (!first) return "";
  const state = first.firmware?.state;
  const lead =
    state === "failed"
      ? `${first.name}'s update didn't finish`
      : state === "updating"
        ? `${first.name} is updating, ${Math.floor(first.firmware?.progress ?? 0)}%`
        : state === "waiting"
          ? `${first.name} updates when it wakes`
          : null;
  if (!lead) return namesOf(updates);
  if (rest.length === 0) return lead;
  return `${lead} · ${state === "updating" ? "then " : ""}${namesOf(rest)}`;
}

/** What the dashboard's Batteries tile says, while a battery is to replace: one device by its name, several by their number. */
export function batteriesTile(devices: readonly DeviceInfo[], now: number) {
  const due = dueBatteries(devices, now);
  const said = (device: DeviceInfo) =>
    maintenanceOf(device, now) === "quiet"
      ? `${device.name} hasn't been heard from since ${sinceWords(device.lastSeenAt!, now)}`
      : `${device.name}'s battery is at ${device.battery}%`;
  const [only] = due;
  if (!only) return null;
  if (due.length === 1) {
    const isQuiet = maintenanceOf(only, now) === "quiet";
    return {
      title: only.name,
      // Short enough for a 1 × 2 tile, as the activity log says it.
      value: isQuiet ? "Gone quiet" : `Battery ${only.battery}%`,
      label: isQuiet
        ? `${said(only)}. Its battery may be empty. Opens Maintenance`
        : `${only.name}'s battery is low, ${only.battery}%. Opens Maintenance`,
    };
  }
  return {
    title: "Batteries",
    // Short enough for a 1 × 2 tile.
    value: `Replace ${due.length}`,
    label: `Batteries, replace ${due.length}: ${due.map(said).join(", ")}. Opens Maintenance`,
  };
}
