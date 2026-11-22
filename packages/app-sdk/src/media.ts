import { z } from "zod";

import { blobHashPattern } from "./blobs.js";

import type { CapabilityDefinition } from "./devices.js";

// A media player: a TV box, a speaker that plays, a smart speaker. Whatever
// brings it, it says what it can do (its features), what it is playing and
// how loud (its state), and takes commands for each.
//
// Most of it is optional, so a smart speaker that only plays, pauses and
// stops fits as well as a TV box: `on` only where it can be turned on and
// off, and whatever it knows of what is playing.

const percent = z.number().int().min(0).max(100);
// Words a player shows, such as a title or an app's name.
const words = z.string().trim().min(1).max(256);
const seconds = z.number().min(0).max(1_000_000);

/** What a media player's playback can do, each as its own word. */
export const mediaPlaybacks = [
  "play",
  "pause",
  "stop",
  "next",
  "previous",
  "seek",
] as const;
export type MediaPlayback = (typeof mediaPlaybacks)[number];

/** What a media player is doing. */
export const mediaActivities = [
  "idle",
  "playing",
  "paused",
  "loading",
] as const;
export type MediaActivity = (typeof mediaActivities)[number];

export const mediaFeatures = z.strictObject({
  // Whether it can be turned on and off.
  power: z.boolean().default(false),
  playback: z
    .array(z.enum(mediaPlaybacks))
    .max(mediaPlaybacks.length)
    .refine((list) => new Set(list).size === list.length, "each once")
    .default([]),
  // A level it can be set to, only up and down, or neither. A TV box that
  // sends its sound to the TV over HDMI only passes up and down on, and
  // never knows how loud the TV is.
  volume: z.enum(["level", "steps"]).nullable().default(null),
  mute: z.boolean().default(false),
});

const mediaInfo = z.strictObject({
  title: words.optional(),
  artist: words.optional(),
  album: words.optional(),
  series: words.optional(),
  season: z.number().int().min(0).max(10_000).optional(),
  episode: z.number().int().min(0).max(100_000).optional(),
  type: z.enum(["music", "video", "episode", "movie"]).optional(),
  duration: seconds.optional(),
  // Where it was at `positionAt`: a client counts on from there while it
  // plays, so a player reports it when it changes, not every second.
  position: seconds.optional(),
  positionAt: z.iso.datetime({ offset: true }).optional(),
  // A picture of what is playing, as the core keeps it, by its SHA-256.
  artwork: z
    .string()
    .regex(blobHashPattern, "a picture's SHA-256 in hex")
    .optional(),
});

export const mediaState = z.strictObject({
  // Only where it has power.
  on: z.boolean().optional(),
  activity: z.enum(mediaActivities),
  // The app that is playing, as the player names it.
  app: z
    .strictObject({ id: z.string().min(1).max(256), name: words })
    .nullable()
    .optional(),
  media: mediaInfo.nullable().optional(),
  // Where its volume is a level.
  volume: percent.optional(),
  // Where it can be muted.
  muted: z.boolean().optional(),
});

// One thing at a time: turn it on or off, play or pause, a step of
// playback, a place in what is playing, a volume or a step of it, mute.
export const mediaCommand = z.union([
  z.strictObject({ on: z.boolean() }),
  z.strictObject({ activity: z.enum(["playing", "paused"]) }),
  z.strictObject({ playback: z.enum(["stop", "next", "previous"]) }),
  z.strictObject({ position: seconds }),
  z.strictObject({ volume: percent }),
  z.strictObject({ volumeStep: z.enum(["up", "down"]) }),
  z.strictObject({ muted: z.boolean() }),
]);

export type MediaFeatures = z.output<typeof mediaFeatures>;
export type MediaState = z.output<typeof mediaState>;
export type MediaCommand = z.output<typeof mediaCommand>;

/**
 * A media player: its features say what it can do, its state what it is
 * playing and how loud, and its commands change one of those. Turning it on
 * or off, playing or pausing, a volume and mute are confirmed by its report;
 * a step of the volume, stop, next, previous and a place in what is playing
 * ask for no state, so nothing waits for them.
 */
export const media = {
  kind: "media",
  version: 1,
  features: mediaFeatures,
  state: mediaState,
  command: mediaCommand,
  desired(command) {
    if ("on" in command) return { on: command.on };
    if ("activity" in command) return { activity: command.activity };
    if ("volume" in command) return { volume: command.volume };
    if ("muted" in command) return { muted: command.muted };
    return {};
  },
  supports(features, command) {
    if ("on" in command) return features.power;
    if ("activity" in command) {
      return features.playback.includes(
        command.activity === "playing" ? "play" : "pause",
      );
    }
    if ("playback" in command)
      return features.playback.includes(command.playback);
    if ("position" in command) return features.playback.includes("seek");
    if ("volume" in command) return features.volume === "level";
    if ("volumeStep" in command) return features.volume !== null;
    return features.mute;
  },
  tier: "write",
} as const satisfies CapabilityDefinition<
  "media",
  MediaFeatures,
  MediaState,
  MediaCommand
>;
