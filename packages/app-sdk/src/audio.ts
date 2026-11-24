import { z } from "zod";

import type { CapabilityDefinition } from "./devices.js";

// A smart speaker's microphones and its voice: whether the microphones are
// muted, when it last heard its wake word, and whether it plays what
// Sanctum says. Whatever brings it, a device that listens for a wake word
// has this part, so the shell shows its microphones the same way for every
// smart speaker. It never carries what the microphones hear.

export const audioFeatures = z.strictObject({
  // Whether Sanctum can mute and unmute its microphones.
  mutes: z.boolean().default(false),
  // Whether it has a mute switch of its own, as on its side, which mutes
  // the microphones too: while that one is on, only it unmutes them.
  muteSwitch: z.boolean().default(false),
  // Whether it plays an announcement from an address the core gives it,
  // over whatever it was playing.
  announces: z.boolean().default(false),
});

export const audioState = z.strictObject({
  // Where it can be muted, by Sanctum or its own switch.
  muted: z.boolean().optional(),
  // When it last heard its wake word.
  heardAt: z.iso.datetime({ offset: true }).optional(),
});

// Mute its microphones, or turn them on; or play the announcement at an
// address. Only the core sends an announcement, with an address of its own
// that serves the sound once: an app or an AI agent asks the core to speak.
export const audioCommand = z.union([
  z.strictObject({ muted: z.boolean() }),
  z.strictObject({
    announce: z.strictObject({
      url: z.url({ protocol: /^http$/ }).max(2_048),
    }),
  }),
]);

export type AudioFeatures = z.output<typeof audioFeatures>;
export type AudioState = z.output<typeof audioState>;
export type AudioCommand = z.output<typeof audioCommand>;

/**
 * A smart speaker's microphones and voice: its features say whether the
 * microphones can be muted and whether it announces, its state whether
 * they are muted and when it last heard its wake word. Muting or unmuting
 * is confirmed by its report; an announcement asks for no state.
 */
export const audio = {
  kind: "audio",
  version: 1,
  features: audioFeatures,
  state: audioState,
  command: audioCommand,
  desired: (command) => ("muted" in command ? { muted: command.muted } : {}),
  supports: (features, command) =>
    "muted" in command ? features.mutes : features.announces,
  tier: "write",
} as const satisfies CapabilityDefinition<
  "audio",
  AudioFeatures,
  AudioState,
  AudioCommand
>;
