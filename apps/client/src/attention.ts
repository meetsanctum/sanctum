import {
  attentionOf,
  type AppInfo,
  type AttentionReason,
  type DeviceInfo,
  type Room,
  type TemperatureUnit,
} from "@meetsanctum/app-sdk";

import {
  givenUpWords,
  isGivenUp,
  looksRunning,
  needsWords,
  stateShort,
  waitingWords,
  wentBackWords,
} from "./app-state";
import { productName } from "./brand";
import { roomName } from "./device-parts";
import { problemShort, problemTitle, type HostProblem } from "./system-status";

// What needs attention: the apps that aren't running and the devices that
// need someone to do something, the most pressing first, in the words
// Settings' section and the dashboard's Attention tile share. Each is a
// condition that holds now and clears itself once dealt with, on every
// client at once, so nothing is dismissed or kept.

/** A device that needs attention, and why, the most pressing reason first. */
export type Attention = { device: DeviceInfo; reasons: AttentionReason[] };

const rank: Record<AttentionReason, number> = {
  left: 0,
  offline: 1,
  room: 2,
};

/** Which reasons are problems, in red with a sign; a room to choose is not. */
export const isProblem = (reason: AttentionReason) => reason !== "room";

/** How a reason sorts, the most pressing first. */
export const rankOf = (reason: AttentionReason) => rank[reason];

/**
 * The devices that need attention, the most pressing first, then by name. Being
 * offline isn't news while someone has turned off the app that drives a device.
 */
export function needingAttention(
  devices: readonly DeviceInfo[],
  rooms: readonly Room[],
  apps: readonly AppInfo[],
): Attention[] {
  const off = new Set(
    apps.filter((app) => app.state === "off").map((app) => app.id),
  );
  return devices
    .map((device) => ({
      device,
      reasons: attentionOf(device, rooms.length > 0).filter(
        (reason) => reason !== "offline" || !off.has(device.driver),
      ),
    }))
    .filter((each) => each.reasons.length > 0)
    .sort(
      (a, b) =>
        rank[a.reasons[0]!] - rank[b.reasons[0]!] ||
        a.device.name.localeCompare(b.device.name),
    );
}

// Not when someone chose to: that needs nobody.
const wentBackFor = (app: AppInfo) => {
  const update = app.run?.update;
  return update?.stage === "wentBack" &&
    !update.chosen &&
    app.state === "running"
    ? update
    : undefined;
};

/**
 * Whether Needs attention lists it: one that needs someone, one paused, and one
 * that has been waiting a while. One on its way back is news to nobody.
 */
function worthTelling(app: AppInfo) {
  // It runs, but someone may want to know it isn't on the version it should be.
  if (wentBackFor(app)?.triesAgain === false) return true;
  if (looksRunning(app)) return false;
  return (
    isGivenUp(app) ||
    app.state === "paused" ||
    (app.state === "waiting" && app.run?.attention === true)
  );
}

/** The installed apps that aren't running, those that stopped first, then by name. */
export function appsNotRunning(apps: readonly AppInfo[]): AppInfo[] {
  const rank = (app: AppInfo) => (isGivenUp(app) ? 0 : 1);
  return apps
    .filter(worthTelling)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// When it began waiting, by this device's clock.
export const clockTime = (since: string | undefined) =>
  since
    ? new Date(since).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

/**
 * What leads an app's line: what is wrong and what to do. A stopped app is
 * a problem; a paused one is not, since someone switched off what it needs, and
 * nor is one waiting, which starts by itself.
 */
export function appAttentionText(app: AppInfo) {
  const back = wentBackFor(app);
  if (back) return wentBackWords(app, back);
  switch (app.state) {
    case "stopped":
      return `Not running: restart ${productName} to start it`;
    case "failed":
      return `Not running: ${givenUpWords.charAt(0).toLowerCase()}${givenUpWords.slice(1)}`;
    case "waiting":
      return `${waitingWords(app)} since ${clockTime(app.run?.since)}. It starts by itself once it can`;
    default:
      return `Paused: ${needsWords(app)}`;
  }
}

/** What a screen reader hears of an app that isn't running. */
export function appAttentionSpoken(app: AppInfo) {
  if (wentBackFor(app)) return `${app.name} went back to ${app.version}`;
  if (isGivenUp(app)) return `${app.name} isn't running`;
  return app.state === "waiting"
    ? `${app.name} is waiting`
    : `${app.name} is paused`;
}

/** What leads a device's line for a reason: what is wrong and what to do. */
export function attentionText(reason: AttentionReason) {
  switch (reason) {
    case "left":
      return "Not paired any more: add it again or remove it";
    case "offline":
      return "Offline: check it's switched on and in range";
    case "room":
      return "No room yet: choose one";
  }
}

// What a reason says after the one that leads.
function following(reason: AttentionReason) {
  switch (reason) {
    case "left":
      return "Not paired any more";
    case "offline":
      return "Offline";
    case "room":
      return "No room yet";
  }
}

/** The rest of a row's line: the reasons after the first, its room and what its driver calls it. */
export function attentionDetail(
  device: DeviceInfo,
  reasons: readonly AttentionReason[],
  rooms: readonly Room[],
) {
  return [
    ...reasons.map(following),
    roomName(rooms, device.roomId),
    device.driverName !== device.name ? device.driverName : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A reason in a word or two, for the Attention tile. */
export function attentionShort(reason: AttentionReason) {
  switch (reason) {
    case "left":
      return "Not paired";
    case "offline":
      return "Offline";
    case "room":
      return "No room";
  }
}

/** What a screen reader hears of a device that needs attention. */
export function attentionSpoken(reason: AttentionReason, device: DeviceInfo) {
  switch (reason) {
    case "left":
      return `${device.name} isn't paired any more`;
    case "offline":
      return `${device.name} is offline`;
    case "room":
      return `${device.name} has no room`;
  }
}

/**
 * The dashboard's Attention tile, while Sanctum, any app or any device
 * needs attention: Sanctum, one app or one device by its name and what is
 * wrong, opening Status or Settings; several by how many, opening Settings.
 */
export function attentionTile(
  needing: readonly Attention[],
  sanctum: readonly HostProblem[] = [],
  unit: TemperatureUnit = "celsius",
  // The apps that aren't running (appsNotRunning).
  apps: readonly AppInfo[] = [],
) {
  if (needing.length === 0 && sanctum.length === 0 && apps.length === 0) {
    return null;
  }
  const spoken = [
    ...(sanctum.length > 0
      ? [
          `${productName}: ${sanctum
            .map((each) => problemTitle(each, unit))
            .join(", ")}`,
        ]
      : []),
    ...apps.map(appAttentionSpoken),
    ...needing.map(({ device, reasons }) =>
      attentionSpoken(reasons[0]!, device),
    ),
  ];
  const problem =
    sanctum.length > 0 ||
    apps.some(isGivenUp) ||
    needing.some(({ reasons }) => reasons.some(isProblem));
  if (apps.length === 1 && needing.length === 0 && sanctum.length === 0) {
    const [app] = apps as [AppInfo];
    return {
      title: app.name,
      value: wentBackFor(app)
        ? `Back on ${app.version}`
        : (stateShort(app) ?? "Not running"),
      label: spoken[0]!,
      problem,
      opens: "settings" as const,
    };
  }
  if (needing.length === 0 && apps.length === 0) {
    return {
      title: productName,
      value: problemShort(sanctum[0]!),
      label: spoken[0]!,
      problem,
      opens: "status" as const,
    };
  }
  if (needing.length === 1 && sanctum.length === 0 && apps.length === 0) {
    const [{ device, reasons }] = needing as [Attention];
    return {
      title: device.name,
      value: attentionShort(reasons[0]!),
      label: spoken[0]!,
      problem,
      opens: "settings" as const,
    };
  }
  // "Sanctum, Moods, 2 devices".
  const count = [
    ...(sanctum.length > 0 ? [productName] : []),
    ...(apps.length === 1
      ? [apps[0]!.name]
      : apps.length > 1
        ? [`${apps.length} apps`]
        : []),
    ...(needing.length > 0
      ? [needing.length === 1 ? "1 device" : `${needing.length} devices`]
      : []),
  ].join(", ");
  return {
    title: "Attention",
    value: count,
    label: `Attention, ${count}: ${spoken.join(", ")}`,
    problem,
    opens: "settings" as const,
  };
}
