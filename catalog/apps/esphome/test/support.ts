import { createDriverCore, type DriverCore } from "@meetsanctum/app-testkit";
import type { CapabilityKind } from "@meetsanctum/app-sdk";
import { ColorMode, EntityCategory } from "esphome-client";
import { fileURLToPath } from "node:url";

import { createEsphomeApp } from "../src/index.js";
import {
  EmulatedDevice,
  newKey,
  type EmulatedEntity,
  type EmulatedOptions,
} from "./emulated-device.js";

// What the app's tests share: emulated devices of each kind, and a home
// whose core is the testkit's, with ESPHome running in it.

export const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

// Short enough for a test to see a device go offline and come back.
export const timings = {
  pingMs: 200,
  offlineMs: 300,
  firstPauseMs: 20,
  longestPauseMs: 100,
  connectMs: 1_000,
  askAgainMs: 150,
};

export const app = (overrides: Partial<typeof timings> = {}) =>
  createEsphomeApp({ timings: { ...timings, ...overrides } });

let macs = 0;

/** A MAC address no other emulated device has. */
export function nextMac() {
  macs += 1;
  return `AA:BB:CC:00:00:${macs.toString(16).padStart(2, "0").toUpperCase()}`;
}

/** The key a device's MAC address is in Sanctum. */
export const keyOf = (mac: string) => mac.toLowerCase();

const light: EmulatedEntity = {
  type: "light",
  key: 101,
  objectId: "bulb",
  name: "Bulb",
  fields: {
    supportedColorModes: [ColorMode.COLOR_TEMPERATURE, ColorMode.RGB],
    minMireds: 153,
    maxMireds: 500,
  },
};

/**
 * One entity of each kind, with a state, as a device of that kind has. A
 * smart speaker's microphones are its Mute switch, on a device with a voice
 * assistant and a media player.
 */
export function entitiesOf(kind: CapabilityKind): {
  entities: EmulatedEntity[];
  states: EmulatedOptions["states"];
  voiceAssistant?: boolean;
} {
  // Its own copy, which a test may change.
  return structuredClone(fixtureOf(kind));
}

function fixtureOf(kind: CapabilityKind): {
  entities: EmulatedEntity[];
  states: EmulatedOptions["states"];
  voiceAssistant?: boolean;
} {
  switch (kind) {
    case "light":
      return {
        entities: [light],
        states: {
          101: {
            state: false,
            brightness: 1,
            colorMode: ColorMode.COLOR_TEMPERATURE,
            colorTemperature: 370,
          },
        },
      };
    case "switch":
      return {
        entities: [
          { type: "switch", key: 102, objectId: "relay", name: "Relay" },
        ],
        states: { 102: { state: false } },
      };
    case "sensor":
      return {
        entities: [
          {
            type: "sensor",
            key: 103,
            objectId: "temperature",
            name: "Temperature",
            fields: { deviceClass: "temperature", unitOfMeasurement: "°C" },
          },
        ],
        states: { 103: { state: 21.5 } },
      };
    case "motion":
      return {
        entities: [
          {
            type: "binary_sensor",
            key: 104,
            objectId: "presence",
            name: "Presence",
            fields: { deviceClass: "occupancy" },
          },
        ],
        states: { 104: { state: false } },
      };
    case "contact":
      return {
        entities: [
          {
            type: "binary_sensor",
            key: 105,
            objectId: "door",
            name: "Door",
            fields: { deviceClass: "door" },
          },
        ],
        states: { 105: { state: true } },
      };
    case "button":
      return {
        entities: [
          {
            type: "event",
            key: 106,
            objectId: "button",
            name: "Button",
            fields: { eventTypes: ["single", "double", "long"] },
          },
        ],
        states: {},
      };
    case "media":
      return {
        entities: [
          {
            type: "media_player",
            key: 107,
            objectId: "media_player",
            name: "Media Player",
            fields: { supportsPause: true },
          },
        ],
        states: { 107: { state: 1, volume: 0.5, muted: false } },
      };
    case "audio":
      return {
        voiceAssistant: true,
        entities: [
          {
            type: "media_player",
            key: 107,
            objectId: "media_player",
            name: "Media Player",
            fields: { supportsPause: true },
          },
          {
            type: "switch",
            key: 108,
            objectId: "mute",
            name: "Mute",
            fields: { entityCategory: EntityCategory.CONFIG },
          },
        ],
        states: {
          107: { state: 1, volume: 0.5, muted: false },
          108: { state: false },
        },
      };
  }
}

/** Its Wi-Fi signal, a diagnostic sensor, as ESPHome's wifi_signal is. */
export const signalEntity: EmulatedEntity = {
  type: "sensor",
  key: 199,
  objectId: "wifi_signal",
  name: "Wi-Fi signal",
  fields: {
    deviceClass: "signal_strength",
    unitOfMeasurement: "dBm",
    entityCategory: EntityCategory.DIAGNOSTIC,
  },
};

/** A home with ESPHome running, and the devices it hears of. */
export async function startHome(timingOverrides?: Partial<typeof timings>) {
  const devices: EmulatedDevice[] = [];
  const core = createDriverCore(app(timingOverrides), { migrationsFolder });
  await core.start();
  return {
    core,
    devices,
    /** A device on the home's network, which ESPHome hears announced. */
    async plugIn(
      options: Partial<EmulatedOptions> & { kind?: CapabilityKind } = {},
    ) {
      const { kind = "switch", ...rest } = options;
      const device = await EmulatedDevice.start({
        name: `device-${devices.length + 1}`,
        mac: nextMac(),
        psk: newKey(),
        ...entitiesOf(kind),
        ...rest,
      });
      devices.push(device);
      await announce(core, device);
      return device;
    },
    async stop() {
      await core.stop();
      core.close();
      await Promise.all(devices.map((device) => device.stop()));
    },
  };
}

/** Has the network announce a device again, as after it changed. */
export async function announce(core: DriverCore, device: EmulatedDevice) {
  await core.discovered({ found: [device.sighting()], lost: [] });
}

/** Adds a device the home found, with its key when it has one. */
export async function add(core: DriverCore, device: EmulatedDevice) {
  const key = keyOf(device.options.mac);
  await core.add(key, device.psk ? { key: device.psk } : {});
  return key;
}
