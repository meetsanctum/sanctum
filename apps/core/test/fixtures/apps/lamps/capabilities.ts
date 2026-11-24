import type { DeviceRegistration, MediaFeatures } from "@meetsanctum/app-sdk";

export const capabilityIds = {
  light: "light",
  switch: "power",
  button: "button",
  media: "media",
  audio: "audio",
} as const;
// What a remote's button can do, and which of that is a hold.
const remoteActions = ["single", "double", "hold"];
const remoteHolds = ["hold"];

// A motion sensor's motion, with its settings, and its two readings.
const motionCapabilities: DeviceRegistration["capabilities"] = [
  {
    id: "occupancy",
    kind: "motion",
    features: {
      sensitivity: ["low", "medium", "high"],
      clearAfter: { min: 10, max: 3600 },
      indicator: true,
    },
  },
  { id: "illuminance", kind: "sensor", features: { measures: "illuminance" } },
  { id: "temperature", kind: "sensor", features: { measures: "temperature" } },
];

// A media player that does all a media player can: power, every step of
// playback, a volume it can be set to, and mute.
const mediaFeatures: MediaFeatures = {
  power: true,
  playback: ["play", "pause", "stop", "next", "previous", "seek"],
  volume: "level",
  mute: true,
};

// A sensor's readings, each a capability.
const sensorCapabilities: DeviceRegistration["capabilities"] = [
  { id: "temperature", kind: "sensor", features: { measures: "temperature" } },
  { id: "humidity", kind: "sensor", features: { measures: "humidity" } },
];

export const capabilities = {
  purifier: [],
  sensor: sensorCapabilities,
  motion: motionCapabilities,
  contact: [{ id: "contact", kind: "contact" }],
  media: [{ id: capabilityIds.media, kind: "media", features: mediaFeatures }],
  audio: [
    { id: capabilityIds.audio, kind: "audio", features: { mutes: true } },
  ],
  light: [
    {
      id: capabilityIds.light,
      kind: "light",
      features: {
        brightness: true,
        colorTemperature: { min: 153, max: 500 },
        color: true,
      },
    },
  ],
  button: [
    {
      id: capabilityIds.button,
      kind: "button",
      features: { actions: remoteActions, holds: remoteHolds },
    },
  ],
  switch: [{ id: capabilityIds.switch, kind: "switch" }],
} satisfies Record<string, DeviceRegistration["capabilities"]>;
