import {
  activityReadPermission,
  aiAssistantPermission,
  historyReadPermission,
} from "./ai-agents.js";
import type { CapabilityKind } from "./devices.js";
import { lanRange } from "./lan.js";
import { modelsUsePermission } from "./models.js";
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
  "radar",
  "network",
  "share-2",
  "shield",
  "list",
  "history",
  "tv",
  "sparkles",
  "mic",
  "bot",
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
  motion: ["Know when there's motion", "activity"],
  contact: [
    "Know whether your doors, windows and contact sensors are open",
    "door-closed",
  ],
  media: ["See your media players", "tv"],
  audio: ["See your smart speakers' microphones", "mic"],
};

const controls: Record<CapabilityKind, [string, PermissionIcon, string?]> = {
  light: ["Control your lights", "lightbulb"],
  switch: ["Control your switches", "toggle-right"],
  button: ["Use your remotes", "circle-dot"],
  sensor: ["Change your sensors", "thermometer"],
  motion: ["Change your motion sensors", "activity"],
  contact: ["Change your contact sensors", "door-closed"],
  media: ["Control your media players", "tv"],
  audio: [
    "Mute and turn on your smart speakers' microphones",
    "mic",
    "See whether the microphones are muted and when they last heard their wake word",
  ],
};

// The services the manager runs, by the names their makers give them.
const serviceNames: Record<string, string> = {
  zigbee2mqtt: "Zigbee2MQTT",
  mosquitto: "Mosquitto",
  ollama: "Ollama",
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
  // Areas of the core's AI agents can use (ai-agents.ts); no app asks for them.
  [activityReadPermission]: {
    title: "See what happened at home",
    detail: null,
    icon: "list",
  },
  [historyReadPermission]: {
    title: "See what your devices reported",
    detail: null,
    icon: "history",
  },
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
  [modelsUsePermission]: {
    title: "Use your home's AI model",
    detail:
      "Lets this app send what it's asked to your home's AI model and read the answers. Your home's limits apply",
    icon: "sparkles",
  },
  [aiAssistantPermission]: {
    title: "Act as your AI assistant",
    detail:
      "Lets this app run actions and read information in your home, but only what Settings and each app allow for AI agents",
    icon: "bot",
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
  if (kind === "discover" && rest.startsWith("mdns:")) {
    return words("Find devices on your network", "radar");
  }
  const range = lanRange(id);
  if (range !== null) {
    return words(
      "Talk to devices on your network",
      "network",
      range.from === range.to
        ? `Port ${range.from}, to the devices it found`
        : `Any port from ${range.from} to ${range.to}, on the devices it found`,
    );
  }
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
