import { ActionError, defineAction, names, partOf } from "@meetsanctum/app-sdk";
import { z } from "zod";

import {
  followAll,
  followed,
  followOne,
  followedRow,
  forget,
  homeSun,
  lightOf,
  takesColorTemperature,
  followOptionsFor,
  type RunForLight,
  type Timing,
} from "./lights.js";
import { preview, previewOf } from "./preview.js";
import { followedLights } from "./schema.js";
import { targetState } from "./target.js";

// Natural light's actions, from v1's natural-lighting routes and its
// reactivation: which lights follow the curve, pausing and resuming one, and
// today's curve. Lights are household things, so every client may use them
// all, shared ones too.
// Following, pausing and resuming are workflow steps too, and the check is
// the app's job. A workflow whose light's device is removed is broken.

const light = z.object({
  device: names("device"),
  capability: partOf("device"),
});

export function naturalLightActions(timing: Timing, runForLight: RunForLight) {
  const follow = defineAction({
    id: "naturalLight.follow",
    title: "Follow natural light",
    tier: "write",
    input: light.extend({ follow: z.boolean() }),
    output: targetState.nullable(),
    words: {
      presets: [
        {
          title: "Let a light follow natural light",
          sentence: "Let {device} follow natural light",
          config: { follow: true },
        },
        {
          title: "Stop a light following natural light",
          sentence: "Stop {device} following natural light",
          config: { follow: false },
        },
      ],
      preview: { device: "Desk lamp" },
    },
    assistant: {
      expose: true,
      description:
        "Have a light follow the sun through the day, or stop following it.",
    },
    async run(ctx, input) {
      const options = await followOptionsFor(ctx, timing);
      return runForLight(input.device, input.capability, async () => {
        const found = await lightOf(ctx, input.device, input.capability);
        if (!input.follow) {
          await forget(ctx, input.device, input.capability);
          return null;
        }
        if (!takesColorTemperature(found.capability)) {
          throw new ActionError(
            "conflict",
            "This light does not take a colour temperature",
          );
        }
        const now = options.now();
        const existing = await followedRow(ctx, input.device, input.capability);
        if (!existing) {
          await ctx.storage.db.insert(followedLights).values({
            deviceId: input.device,
            capabilityId: input.capability,
            since: now,
          });
        }
        const row = (await followedRow(ctx, input.device, input.capability))!;
        // A light that begins following takes the curve at once (v1).
        try {
          return await followOne(
            ctx,
            found,
            row,
            await homeSun(ctx, now),
            options,
            !existing,
          );
        } catch (error) {
          // A refused first command must not silently enable the job.
          if (!existing) await forget(ctx, input.device, input.capability);
          throw error;
        }
      });
    },
  });

  const resume = defineAction({
    id: "naturalLight.resume",
    title: "Resume natural light",
    tier: "write",
    input: light,
    output: targetState,
    words: {
      sentence: "Resume natural light on {device}",
      preview: { device: "Desk lamp" },
    },
    async run(ctx, input) {
      const options = await followOptionsFor(ctx, timing);
      return runForLight(input.device, input.capability, async () => {
        const found = await lightOf(ctx, input.device, input.capability);
        const row = await followedRow(ctx, input.device, input.capability);
        if (!row) {
          throw new ActionError("not_found", "This light does not follow it");
        }
        const now = options.now();
        const resumed = { ...row, since: now, pausedAt: null };
        const target = await followOne(
          ctx,
          found,
          resumed,
          await homeSun(ctx, now),
          options,
          true,
        );
        await ctx.storage.db
          .update(followedLights)
          .set({ since: now, pausedAt: null })
          .where(followed(input.device, input.capability));
        return target;
      });
    },
  });

  const pause = defineAction({
    id: "naturalLight.pause",
    title: "Pause natural light",
    tier: "write",
    input: light,
    output: targetState,
    words: {
      sentence: "Pause natural light on {device}",
      preview: { device: "Desk lamp" },
    },
    async run(ctx, input) {
      const options = await followOptionsFor(ctx, timing);
      return runForLight(input.device, input.capability, async () => {
        const found = await lightOf(ctx, input.device, input.capability);
        const row = await followedRow(ctx, input.device, input.capability);
        if (!row) {
          throw new ActionError("not_found", "This light does not follow it");
        }
        const now = options.now();
        await ctx.storage.db
          .update(followedLights)
          .set({ pausedAt: now })
          .where(followed(input.device, input.capability));
        return followOne(
          ctx,
          found,
          { ...row, pausedAt: now },
          await homeSun(ctx, now),
          options,
        );
      });
    },
  });

  const showPreview = defineAction({
    id: "naturalLight.preview",
    title: "Today's natural light",
    tier: "read",
    input: z.object({}),
    // None until the home has a location and the sun rises and sets today.
    output: preview.nullable(),
    async run(ctx) {
      const options = await followOptionsFor(ctx, timing);
      const now = options.now();
      const sun = await homeSun(ctx, now);
      return sun ? previewOf(options.curve, sun, now) : null;
    },
  });

  // v1's interval automations, as the app's job (index.ts).
  const check = defineAction({
    id: "naturalLight.check",
    title: "Bring lights to natural light",
    tier: "write",
    input: z.object({}),
    output: z.object({}),
    async run(ctx) {
      const options = await followOptionsFor(ctx, timing);
      await followAll(ctx, options, runForLight);
      return {};
    },
  });

  return { follow, resume, pause, preview: showPreview, check };
}
