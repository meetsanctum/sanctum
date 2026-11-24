import { ActionError, defineAction } from "@meetsanctum/app-sdk";
import { z } from "zod";

import type { DeviceFacts } from "./facts.js";
import type { SpeakerChange, SpeakerState } from "./speaker.js";

// What a device's page asks the app: how the device was reached, what it
// runs and its signal, as its connection last told them, and on a smart
// speaker its ring, which it can change. None of these is offered to AI
// agents: they're the page's.

const deviceFacts = z.object({
  address: z.string(),
  encrypted: z.boolean(),
  version: z.string().nullable(),
  signal: z.number().nullable(),
  unused: z.array(z.string()),
  sleeps: z.boolean(),
  firstKey: z.enum(["setup"]).nullable(),
});

const colour = z.string().regex(/^#[0-9a-f]{6}$/);

const ring = z.object({
  glow: z.boolean(),
  colour,
  brightness: z.number().int().min(0).max(100),
});

const speakerState = z.object({ ring: ring.nullable() });

export function deviceAction(
  facts: (deviceId: string) => Promise<DeviceFacts | null>,
) {
  return defineAction({
    id: "esphome.device",
    title: "Device",
    tier: "read",
    input: z.object({ device: z.string() }),
    output: deviceFacts,
    async run(_ctx, input) {
      const found = await facts(input.device);
      if (!found) throw new ActionError("not_found", "No such device");
      return found;
    },
  });
}

export type DeviceAction = ReturnType<typeof deviceAction>;

export function speakerAction(
  read: (deviceId: string) => Promise<SpeakerState | null>,
) {
  return defineAction({
    id: "esphome.speaker",
    title: "Smart speaker",
    tier: "read",
    input: z.object({ device: z.string() }),
    output: speakerState,
    async run(_ctx, input) {
      const found = await read(input.device);
      if (!found) throw new ActionError("not_found", "No such smart speaker");
      return found;
    },
  });
}

export type SpeakerAction = ReturnType<typeof speakerAction>;

// A change to the ring is an action of its own, about the speaker, so
// Activity says what was done to which speaker and joins a slider's steps.

export function changeRingAction(
  change: (deviceId: string, change: SpeakerChange) => Promise<void>,
) {
  return defineAction({
    id: "esphome.changeRing",
    title: "Change its ring",
    tier: "write",
    aboutDevice: { done: "Changed its ring" },
    input: z
      .object({
        device: z.string(),
        glow: z.boolean().optional(),
        colour: colour.optional(),
        brightness: z.number().int().min(20).max(100).optional(),
      })
      .refine(
        ({ glow, colour, brightness }) =>
          glow !== undefined ||
          colour !== undefined ||
          brightness !== undefined,
        "Give at least one ring setting",
      ),
    output: z.object({}),
    async run(_ctx, { device, ...ring }) {
      await change(device, { ring });
      return {};
    },
  });
}

export type ChangeRingAction = ReturnType<typeof changeRingAction>;
