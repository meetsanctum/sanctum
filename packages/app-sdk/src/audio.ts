import { z } from "zod";

import type { CapabilityDefinition } from "./devices.js";

// A smart speaker's microphones: whether they're muted, and when it last
// heard its wake word. Whatever brings it, a device that listens for a wake
// word has this part, so the shell shows its microphones the same way for
// every smart speaker. It never carries what the microphones hear.

export const audioFeatures = z.strictObject({
  // Whether Sanctum can mute and unmute its microphones.
  mutes: z.boolean().default(false),
  // Whether it has a mute switch of its own, as on its side, which mutes
  // the microphones too: while that one is on, only it unmutes them.
  muteSwitch: z.boolean().default(false),
});

export const audioState = z.strictObject({
  // Where it can be muted, by Sanctum or its own switch.
  muted: z.boolean().optional(),
  // When it last heard its wake word.
  heardAt: z.iso.datetime({ offset: true }).optional(),
});

// Mute its microphones, or turn them on.
export const audioCommand = z.strictObject({ muted: z.boolean() });

export type AudioFeatures = z.output<typeof audioFeatures>;
export type AudioState = z.output<typeof audioState>;
export type AudioCommand = z.output<typeof audioCommand>;

/**
 * A smart speaker's microphones: its features say whether they can be
 * muted, its state whether they are and when it last heard its wake word,
 * and its one command mutes or unmutes them, which its report confirms.
 */
export const audio = {
  kind: "audio",
  version: 1,
  features: audioFeatures,
  state: audioState,
  command: audioCommand,
  desired: (command) => ({ muted: command.muted }),
  supports: (features) => features.mutes,
  tier: "write",
} as const satisfies CapabilityDefinition<
  "audio",
  AudioFeatures,
  AudioState,
  AudioCommand
>;
