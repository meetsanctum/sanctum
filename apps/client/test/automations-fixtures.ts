import type {
  DeviceInfo,
  PieceInfo,
  Places,
  WorkflowInfo,
} from "@meetsanctum/app-sdk";

import type { Names } from "../src/automations/words";

// Pieces as GET /api/workflows/pieces gives them, cut down to what
// Automations reads: their schemas' markers, sentences, cards, presets and
// groups.

const piece = (
  fields: Omit<
    PieceInfo,
    "icon" | "sentence" | "card" | "presets" | "group" | "needs"
  > &
    Partial<PieceInfo>,
): PieceInfo => ({
  icon: null,
  sentence: null,
  card: null,
  presets: [],
  needs: [],
  group: null,
  ...fields,
});

export const time = piece({
  kind: "trigger",
  app: null,
  id: "time",
  title: "At a time of day",
  icon: "clock",
  group: "Time",
  sentence: "At {time} {days}",
  card: { name: "{time}", specifics: "{days}" },
  config: {
    type: "object",
    properties: {
      time: { type: "string", timeOfDay: true },
      days: {
        type: "array",
        days: true,
        items: {
          type: "string",
          enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        },
      },
    },
    required: ["time"],
  },
});

export const sun = piece({
  kind: "trigger",
  app: null,
  id: "sun",
  title: "At sunrise or sunset",
  icon: "sunset",
  group: "Sunrise and sunset",
  sentence: "At {event}, {offsetMinutes}",
  card: { name: "{event}", specifics: "{offsetMinutes}" },
  presets: [
    {
      title: "At sunrise",
      sentence: "At sunrise, {offsetMinutes}",
      icon: "sunrise",
      config: { event: "sunrise" },
    },
    {
      title: "At sunset",
      sentence: "At sunset, {offsetMinutes}",
      icon: "sunset",
      config: { event: "sunset" },
    },
  ],
  config: {
    type: "object",
    properties: {
      event: {
        type: "string",
        enum: ["sunrise", "sunset"],
        labels: { sunrise: "sunrise", sunset: "sunset" },
      },
      offsetMinutes: { type: "integer", default: 0, offsetMinutes: true },
    },
    required: ["event"],
  },
});

export const manual = piece({
  kind: "trigger",
  app: null,
  id: "manual",
  title: "Run by hand",
  icon: "hand",
  group: "By hand",
  sentence: "By hand",
  card: { name: "By hand", specifics: null },
  config: { type: "object", properties: {} },
});

export const press = piece({
  kind: "trigger",
  app: null,
  id: "press",
  title: "A remote is pressed",
  icon: "circle-dot",
  group: "Buttons",
  sentence: "{action} on {device}",
  card: { name: "{device}", specifics: "{action}" },
  config: {
    type: "object",
    properties: {
      device: { type: "string", names: "device" },
      capability: { type: "string", partOf: "device" },
      action: { type: "string" },
    },
    required: ["device"],
  },
});

export const lights = piece({
  kind: "step",
  app: null,
  id: "lights",
  title: "Switch lights",
  icon: "lightbulb",
  sentence: "{to} the lights in {place}",
  presets: [
    {
      title: "Turn on the lights",
      sentence: "Turn on the lights in {place}",
      config: { to: "on" },
    },
    {
      title: "Turn off the lights",
      sentence: "Turn off the lights in {place}",
      config: { to: "off" },
    },
  ],
  config: {
    type: "object",
    properties: {
      place: { place: true, oneOf: [] },
      to: {
        type: "string",
        enum: ["toggle", "on", "off", "brighter", "brightenWhileHeld"],
        labels: {
          toggle: "Turn on or off",
          on: "Turn on",
          off: "Turn off",
          brighter: "Brighten",
          brightenWhileHeld: "While held, brighten",
        },
      },
    },
    required: ["place", "to"],
  },
});

export const runMood = piece({
  kind: "step",
  app: "sanctum.moods",
  id: "moods.runMood",
  title: "Run a mood",
  sentence: "Run {id}",
  config: {
    type: "object",
    properties: { id: { type: "string", entityOf: "moods.mood" } },
    required: ["id"],
  },
});

export const pieces = [time, sun, manual, press, lights, runMood];

// The core's motion and light-level pieces, and its device pieces with
// their motion and reading presets, as the core gives them.
const place = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "room" },
        id: { type: "string", names: "room" },
      },
      required: ["kind", "id"],
    },
    {
      type: "object",
      properties: { kind: { type: "string", const: "home" } },
      required: ["kind"],
    },
  ],
  place: true,
};
const forMinutes = { type: "integer", minimum: 1, maximum: 240, minutes: true };
const operator = {
  type: "string",
  enum: ["equals", "not_equals", "is_on", "is_off", "below", "above"],
};

export const motion = piece({
  kind: "trigger",
  app: null,
  id: "motion",
  title: "Motion in a place",
  icon: "footprints",
  group: "Motion",
  sentence: "Motion in {place}",
  card: { name: "{place}", specifics: "Motion" },
  config: {
    type: "object",
    properties: { place },
    required: ["place"],
  },
});

export const noMotion = piece({
  kind: "trigger",
  app: null,
  id: "noMotion",
  title: "No motion in a place for a while",
  icon: "footprints",
  group: "Motion",
  sentence: "No motion in {place} for {forMinutes}",
  card: { name: "{place}", specifics: "No motion for {forMinutes}" },
  config: {
    type: "object",
    properties: { place, forMinutes },
    required: ["place", "forMinutes"],
  },
});

export const lightLevel = piece({
  kind: "condition",
  app: null,
  id: "lightLevel",
  title: "A place's light level",
  icon: "sun",
  sentence: "{place} is {is} {lux}",
  presets: [
    {
      title: "Darker than",
      sentence: "{place} is darker than {lux}",
      config: { is: "darker" },
    },
    {
      title: "Brighter than",
      sentence: "{place} is brighter than {lux}",
      config: { is: "brighter" },
    },
  ],
  config: {
    type: "object",
    properties: {
      place,
      is: {
        type: "string",
        enum: ["darker", "brighter"],
        labels: { darker: "darker than", brighter: "brighter than" },
      },
      lux: { type: "number", minimum: 0, maximum: 200000, lux: true },
    },
    required: ["place", "is", "lux"],
  },
});

export const deviceTrigger = piece({
  kind: "trigger",
  app: null,
  id: "device",
  title: "A device changes",
  sentence: "{device} changes",
  card: { name: "{device}", specifics: "Changes" },
  presets: [
    {
      title: "Detects motion",
      sentence: "{device} detects motion",
      card: { name: "{device}", specifics: "Detects motion" },
      config: { kind: "occupancy", field: "occupied", operator: "is_on" },
    },
  ],
  config: {
    type: "object",
    properties: {
      device: { type: "string", names: "device" },
      capability: { type: "string", partOf: "device" },
      kind: {
        type: "string",
        enum: ["light", "switch", "button", "sensor", "occupancy"],
      },
      field: { type: "string" },
      operator,
      value: {},
    },
  },
});

export const deviceCondition = piece({
  kind: "condition",
  app: null,
  id: "device",
  title: "A device is",
  presets: [
    {
      title: "Is on",
      sentence: "{device} is on",
      config: { field: "on", operator: "is_on" },
    },
    {
      title: "Sees motion",
      sentence: "{device} sees motion",
      config: { field: "occupied", operator: "is_on" },
    },
  ],
  config: {
    type: "object",
    properties: {
      device: { type: "string", names: "device" },
      capability: { type: "string", partOf: "device" },
      field: { type: "string" },
      operator,
      value: {},
    },
    required: ["device", "field", "operator"],
  },
});

export const motionPieces = [
  motion,
  noMotion,
  lightLevel,
  deviceTrigger,
  deviceCondition,
];

/** A motion sensor that reads the light level, in the office. */
export const motionSensor = {
  id: "motion",
  name: "Office motion sensor",
  roomId: "office",
  availability: "online",
  capabilities: [
    {
      id: "occupancy",
      kind: "occupancy",
      features: {
        senses: "motion",
        sensitivity: null,
        clearAfter: null,
        indicator: false,
      },
      observed: { occupied: false },
    },
    {
      id: "illuminance",
      kind: "sensor",
      features: { measures: "illuminance" },
      observed: { value: 320 },
    },
  ],
} as unknown as DeviceInfo;

export const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  rooms: [
    { id: "office", name: "Office" },
    { id: "living", name: "Living room" },
  ],
  zones: [],
} as unknown as Places;

export const devices = [
  {
    id: "button",
    name: "Office button",
    roomId: "office",
    capabilities: [
      {
        id: "button",
        kind: "button",
        features: { actions: ["single", "double"], holds: [] },
      },
    ],
  },
  {
    id: "ceiling",
    name: "Office ceiling",
    roomId: "office",
    capabilities: [{ id: "light", kind: "light" }],
  },
] as unknown as DeviceInfo[];

export const names: Names = {
  room: (id) => places.rooms.find((room) => room.id === id)?.name,
  zone: () => undefined,
  device: (id) => {
    const device = [...devices, motionSensor].find((each) => each.id === id);
    return (
      device && {
        name: device.name,
        kinds: device.capabilities.map((each) => each.kind),
      }
    );
  },
  entity: (type, key) =>
    type === "moods.mood" && key === "focus" ? "Focus" : undefined,
  app: (id) => (id === "sanctum.moods" ? "Moods" : undefined),
};

export function workflow(
  fields: Partial<WorkflowInfo> & Pick<WorkflowInfo, "id" | "name" | "graph">,
): WorkflowInfo {
  return {
    enabled: true,
    runMode: "single",
    version: 1,
    createdBy: null,
    app: null,
    appKey: null,
    problems: [],
    warnings: [],
    suspended: [],
    lastRun: null,
    nextRun: null,
    createdAt: "2026-10-30T08:00:00.000Z",
    updatedAt: "2026-10-30T08:00:00.000Z",
    ...fields,
  };
}
