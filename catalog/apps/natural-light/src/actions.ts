import {
  ActionError,
  defineAction,
  names,
  partOf,
  type AppContext,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { isLeftOut, leaveOut, takeBack, takeInLights } from "./choices.js";
import {
  followAll,
  followed,
  followOne,
  followedRow,
  forget,
  homeSun,
  letGo,
  lightOf,
  takesColorTemperature,
  followOptionsFor,
  type FollowOptions,
  type RunForLight,
  type Timing,
} from "./lights.js";
import { preview, previewOf } from "./preview.js";
import {
  bringRoom as bringToNaturalLight,
  publishRooms,
  toggleRoom as pressRoomButton,
} from "./rooms.js";
import { followedLights } from "./schema.js";
import { targetState, type TargetState } from "./target.js";

// Natural light's actions: leaving a light or a room's lights out of the
// curve or having them follow again, pausing and resuming one, a press of a
// room's button and bringing a room to natural light, and today's curve.
// Whatever changes which lights follow, or whether one is paused, publishes
// the room buttons again (rooms.ts). Lights are
// household things, so every client may use them all, shared ones too.
// Following, pausing and resuming are workflow steps too, and the check is
// the app's job. A workflow whose light's device is removed is broken.

const light = z.object({
  device: names("device"),
  capability: partOf("device"),
});

// The lights a press could not reach, which the shell fails on their tiles.
const failedLights = z.object({
  failed: z.array(z.object({ device: z.string(), capability: z.string() })),
});

// The room buttons again, after a change; a failure here leaves the action
// done, and the next check publishes them.
async function roomsChanged(
  ctx: AppContext,
  options: FollowOptions,
  rooms?: readonly (string | null)[],
) {
  try {
    await publishRooms(ctx, options, rooms ? { rooms } : undefined);
  } catch (error) {
    ctx.log(
      `could not publish the room buttons (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

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
      const target = await setFollowing(ctx, options, runForLight, input);
      await roomsChanged(ctx, options);
      return target;
    },
  });

  // A room's switch on the page: every light in the room that takes a
  // colour temperature, or every one in no room for null, follows or is
  // left out as its own switch would have it. Switched off, it also leaves
  // out a light that still follows though it no longer says it takes a
  // colour temperature, as the page lists it in the room. A light that
  // can't be changed is named in `failed`, and the others still are.
  const followRoom = defineAction({
    id: "naturalLight.followRoom",
    title: "Follow natural light in a room",
    tier: "write",
    input: z.object({
      placeId: z.string().min(1).max(64).nullable(),
      follow: z.boolean(),
    }),
    output: failedLights,
    async run(ctx, input) {
      const options = await followOptionsFor(ctx, timing);
      const failed: { device: string; capability: string }[] = [];
      for (const device of await ctx.devices.list()) {
        if (device.roomId !== input.placeId) continue;
        for (const capability of device.capabilities) {
          const stillFollows =
            !input.follow &&
            capability.kind === "light" &&
            (await followedRow(ctx, device.id, capability.id)) !== undefined;
          if (!takesColorTemperature(capability) && !stillFollows) continue;
          const each = { device: device.id, capability: capability.id };
          try {
            await setFollowing(ctx, options, runForLight, {
              ...each,
              follow: input.follow,
            });
          } catch (error) {
            ctx.log(
              `could not change ${device.name} (${error instanceof Error ? error.message : String(error)})`,
            );
            failed.push(each);
          }
        }
      }
      await roomsChanged(ctx, options, [input.placeId]);
      return { failed };
    },
  });

  // A press of a room's Natural light button (index.ts' room section): off
  // while the room is on natural light, and to natural light otherwise.
  const toggleRoom = defineAction({
    id: "naturalLight.toggleRoom",
    title: "Switch a room's natural light",
    tier: "write",
    input: z.object({ placeId: z.string().min(1).max(64) }),
    output: failedLights,
    async run(ctx, input) {
      const options = await followOptionsFor(ctx, timing);
      const failed = await pressRoomButton(
        ctx,
        options,
        runForLight,
        input.placeId,
      );
      await roomsChanged(ctx, options, [input.placeId]);
      return { failed };
    },
  });

  // Every light in a room that follows on at the curve and the others off,
  // as a grey press of its button does, for automations.
  const bringRoom = defineAction({
    id: "naturalLight.bringRoom",
    title: "Bring a room to natural light",
    tier: "write",
    input: z.object({ placeId: names("room") }),
    output: failedLights,
    words: {
      sentence: "Bring {placeId} to natural light",
      preview: { placeId: "Living room" },
    },
    async run(ctx, input) {
      const options = await followOptionsFor(ctx, timing);
      const failed = await bringToNaturalLight(
        ctx,
        options,
        runForLight,
        input.placeId,
      );
      await roomsChanged(ctx, options, [input.placeId]);
      return { failed };
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
      }).then(async (target) => {
        await roomsChanged(ctx, options);
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
      }).then(async (target) => {
        await roomsChanged(ctx, options);
        return target;
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

  // The app's job (index.ts): it takes in lights that are new meanwhile,
  // then brings every light that follows to the curve.
  const check = defineAction({
    id: "naturalLight.check",
    title: "Bring lights to natural light",
    tier: "write",
    input: z.object({}),
    output: z.object({}),
    async run(ctx) {
      const options = await followOptionsFor(ctx, timing);
      try {
        await takeInLights(ctx, runForLight);
      } catch (error) {
        ctx.log(
          `could not take in new lights (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      await followAll(ctx, options, runForLight);
      await roomsChanged(ctx, options);
      return {};
    },
  });

  return {
    follow,
    followRoom,
    toggleRoom,
    bringRoom,
    resume,
    pause,
    preview: showPreview,
    check,
  };
}

/**
 * Has one light follow the curve, or leaves it out, as the household
 * chose: a light left out lets go of a look natural light holds for it,
 * and one that begins to follow takes the curve at once.
 */
async function setFollowing(
  ctx: AppContext,
  options: FollowOptions,
  runForLight: RunForLight,
  input: { device: string; capability: string; follow: boolean },
): Promise<TargetState | null> {
  return runForLight(input.device, input.capability, async () => {
    const found = await lightOf(ctx, input.device, input.capability);
    if (!input.follow) {
      // Left out, it comes back on as it remembers itself rather than
      // at a look natural light still holds for it.
      await leaveOut(ctx, input.device, input.capability);
      const wasFollowing = await followedRow(
        ctx,
        input.device,
        input.capability,
      );
      await forget(ctx, input.device, input.capability);
      if (wasFollowing && options.isOn) {
        try {
          await letGo(ctx, found);
        } catch {
          ctx.log(`could not let go of ${found.device.name}`);
        }
      }
      return null;
    }
    if (!takesColorTemperature(found.capability)) {
      throw new ActionError(
        "conflict",
        "This light does not take a colour temperature",
      );
    }
    const wasLeftOut = await isLeftOut(ctx, input.device, input.capability);
    await takeBack(ctx, input.device, input.capability);
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
    // A light that begins following takes the curve at once.
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
      // A refused first command must not silently enable the job, nor
      // take back a light the household had left out.
      if (!existing) await forget(ctx, input.device, input.capability);
      if (!existing && wasLeftOut) {
        await leaveOut(ctx, input.device, input.capability);
      }
      throw error;
    }
  });
}
