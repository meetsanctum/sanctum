import {
  ColorMode,
  EntityCategory,
  MediaPlayerFormatPurpose,
  MediaPlayerState,
} from "esphome-client";

import type { EmulatedEntity } from "./emulated-device.js";
import type { startHome } from "./support.js";

// A Home Assistant Voice PE as its firmware shows itself over the API: its
// player, its button's presses, its microphones' Mute switch and its LED
// ring, and settings of its own, one hidden by default.

export const player: EmulatedEntity = {
  type: "media_player",
  key: 201,
  objectId: "media_player",
  name: "Media Player",
  // Volume set, mute and stop are standard. The speaker also supports Play and Pause.
  fields: {
    featureFlags: (1 << 0) | (1 << 2) | (1 << 3) | (1 << 12) | (1 << 14),
  },
  // What it plays, as its firmware lists it: music in stereo, and
  // announcements in mono, which makes it announce.
  messages: {
    supportedFormats: [
      { format: "flac", sampleRate: 48_000, numChannels: 2, sampleBytes: 2 },
      {
        format: "flac",
        sampleRate: 48_000,
        numChannels: 1,
        purpose: MediaPlayerFormatPurpose.ANNOUNCEMENT,
        sampleBytes: 2,
      },
    ],
  },
};

// The parts a Voice PE shows over its API, as its firmware names them.
const voicePeEntities: EmulatedEntity[] = [
  player,
  {
    type: "event",
    key: 202,
    objectId: "button_press",
    name: "Button press",
    fields: {
      deviceClass: "button",
      eventTypes: [
        "double_press",
        "triple_press",
        "long_press",
        "easter_egg_press",
      ],
    },
  },
  {
    type: "switch",
    key: 203,
    objectId: "mute",
    name: "Mute",
    fields: { entityCategory: EntityCategory.CONFIG },
  },
  {
    type: "light",
    key: 204,
    objectId: "led_ring",
    name: "LED Ring",
    fields: {
      entityCategory: EntityCategory.CONFIG,
      supportedColorModes: [ColorMode.RGB],
    },
  },
  {
    type: "button",
    key: 205,
    objectId: "restart",
    name: "Restart",
    fields: { entityCategory: EntityCategory.CONFIG, disabledByDefault: true },
  },
  {
    type: "switch",
    key: 206,
    objectId: "wake_sound",
    name: "Wake sound",
    fields: { entityCategory: EntityCategory.CONFIG },
  },
];

/** A Voice PE on the home's network, its microphones on and its ring as it ships. */
export const voicePe = (
  home: Awaited<ReturnType<typeof startHome>>,
  options: { streamsOverApi?: boolean; psk?: string | null } = {},
) =>
  home.plugIn({
    name: "voice",
    project: "Nabu Casa.Home Assistant Voice PE",
    voiceAssistant: true,
    ...options,
    streamsOverApi: options.streamsOverApi ?? true,
    entities: voicePeEntities,
    states: {
      201: { state: MediaPlayerState.IDLE, volume: 0.6 },
      203: { state: false },
      204: {
        state: false,
        brightness: 0.66,
        colorMode: ColorMode.RGB,
        red: 0.094,
        green: 0.733,
        blue: 0.949,
      },
      206: { state: true },
    },
  });
