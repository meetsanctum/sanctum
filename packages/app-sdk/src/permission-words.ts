import type { CapabilityKind } from "./devices.js";
import { turnOnType } from "./lights.js";
import { forecastType, sunType } from "./weather.js";

// How Sanctum names each permission, the same for every app: a permission's
// id means nothing to a household, and the app's reason says why it asks,
// not what it may do. So an app's settings page shows Sanctum's title for
// what the permission lets it do, a line of detail where one helps, and an
// icon, then the app's reason. Every client says the same.

/** The icons a permission may have, as Lucide names them; the shell draws each. */
export const permissionIcons = [
  "door-closed",
  "map-pin",
  "users",
  "lightbulb",
  "toggle-right",
  "circle-dot",
  "thermometer",
  "activity",
  "square-plus",
  "workflow",
  "globe",
  "radio-tower",
  "share-2",
  "shield",
] as const;
export type PermissionIcon = (typeof permissionIcons)[number];

export type PermissionWords = {
  /** What it lets the app do, such as "Control your lights". */
  title: string;
  /** A line under it where one helps, such as who may hold it. */
  detail: string | null;
  icon: PermissionIcon;
};

const reads: Record<CapabilityKind, [string, PermissionIcon]> = {
  light: ["See your lights", "lightbulb"],
  switch: ["See your switches", "toggle-right"],
  button: ["See your remotes' presses", "circle-dot"],
  sensor: ["See what your sensors read", "thermometer"],
  occupancy: ["Know when there's motion", "activity"],
};

const controls: Record<CapabilityKind, [string, PermissionIcon]> = {
  light: ["Control your lights", "lightbulb"],
  switch: ["Control your switches", "toggle-right"],
  button: ["Use your remotes", "circle-dot"],
  sensor: ["Change your sensors", "thermometer"],
  occupancy: ["Change your motion sensors", "activity"],
};

// The services the manager runs, by the names their makers give them.
const serviceNames: Record<string, string> = {
  zigbee2mqtt: "Zigbee2MQTT",
  mosquitto: "Mosquitto",
};

// The standard types other apps read, by what they hold.
const sharedTypes: Record<string, string> = {
  [sunType.id]: "Read the sun times",
  [forecastType.id]: "Read the forecast",
  [turnOnType.id]: "Read how rooms' lights turn on",
};

const fixed: Record<string, PermissionWords> = {
  "places.read": { title: "See your rooms", detail: null, icon: "door-closed" },
  "places.location": {
    title: "Know where your home is",
    detail: null,
    icon: "map-pin",
  },
  "people.read": { title: "See who lives here", detail: null, icon: "users" },
  "devices.register": {
    title: "Bring devices into your home",
    detail: null,
    icon: "square-plus",
  },
  "workflows.manage": {
    title: "Keep its own automations",
    detail: null,
    icon: "workflow",
  },
};

const words = (
  title: string,
  icon: PermissionIcon,
  detail: string | null = null,
): PermissionWords => ({ title, detail, icon });

/** How Sanctum names a permission; one it doesn't know keeps its id. */
export function permissionWords(id: string): PermissionWords {
  if (Object.hasOwn(fixed, id)) return { ...fixed[id]! };
  const colon = id.indexOf(":");
  const kind = colon === -1 ? id : id.slice(0, colon);
  const rest = colon === -1 ? "" : id.slice(colon + 1);
  if (kind === "devices.read" && Object.hasOwn(reads, rest)) {
    return words(...reads[rest as CapabilityKind]);
  }
  if (kind === "devices.control" && Object.hasOwn(controls, rest)) {
    return words(...controls[rest as CapabilityKind]);
  }
  if (kind === "net" && rest) return words(`Reach ${rest}`, "globe");
  if (kind === "services" && rest) {
    const name = Object.hasOwn(serviceNames, rest) ? serviceNames[rest]! : rest;
    return words(`Use ${name}`, "radio-tower", "Only Sanctum's own apps");
  }
  if (kind === "entities.read" && rest) {
    return words(
      Object.hasOwn(sharedTypes, rest)
        ? sharedTypes[rest]!
        : `Read what other apps share as ${rest}`,
      "share-2",
    );
  }
  return words(id, "shield");
}
