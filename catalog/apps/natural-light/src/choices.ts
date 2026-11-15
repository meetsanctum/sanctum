import type { AppContext } from "@meetsanctum/app-sdk";
import { and, eq } from "drizzle-orm";

import {
  followedRow,
  takesColorTemperature,
  type RunForLight,
} from "./lights.js";
import { followedLights, leftOutLights } from "./schema.js";

// Which lights follow natural light: every light that takes a colour
// temperature, wherever it is and however new, unless the household left
// it out. Natural light keeps the lights left out, and takes in the others
// as it sees them: as it starts, at each check and as a light is added.
//
// A light taken in this way counts whatever was set before as someone
// else's (`since` is the epoch), so a light that is on with a mood or a
// look of a person's stays as it is until it is switched off, and one that
// is on as it remembers itself takes the curve. One the household has
// follow again on purpose takes the curve at once (actions.ts).

/** Whether the household left a light out of natural light. */
export async function isLeftOut(
  ctx: AppContext,
  device: string,
  capability: string,
) {
  const row = await ctx.storage.db
    .select()
    .from(leftOutLights)
    .where(
      and(
        eq(leftOutLights.deviceId, device),
        eq(leftOutLights.capabilityId, capability),
      ),
    )
    .get();
  return row !== undefined;
}

/** Leaves a light out of natural light, as the household chose. */
export async function leaveOut(
  ctx: AppContext,
  device: string,
  capability: string,
) {
  await ctx.storage.db
    .insert(leftOutLights)
    .values({ deviceId: device, capabilityId: capability })
    .onConflictDoNothing();
}

/** Takes a light back into natural light, as the household chose. */
export async function takeBack(
  ctx: AppContext,
  device: string,
  capability: string,
) {
  await ctx.storage.db
    .delete(leftOutLights)
    .where(
      and(
        eq(leftOutLights.deviceId, device),
        eq(leftOutLights.capabilityId, capability),
      ),
    );
}

/**
 * Has every light that takes a colour temperature and isn't left out
 * follow natural light, and says which began to. Each light is decided in
 * its turn (runForLight), so a light the household leaves out meanwhile
 * stays out.
 */
export async function takeInLights(
  ctx: AppContext,
  runForLight: RunForLight,
): Promise<{ device: string; capability: string }[]> {
  const devices = await ctx.devices.list();
  const began: { device: string; capability: string }[] = [];
  for (const device of devices) {
    for (const capability of device.capabilities) {
      if (!takesColorTemperature(capability)) continue;
      await runForLight(device.id, capability.id, async () => {
        if (
          (await isLeftOut(ctx, device.id, capability.id)) ||
          (await followedRow(ctx, device.id, capability.id))
        ) {
          return;
        }
        await ctx.storage.db
          .insert(followedLights)
          .values({
            deviceId: device.id,
            capabilityId: capability.id,
            since: new Date(0),
          })
          .onConflictDoNothing();
        began.push({ device: device.id, capability: capability.id });
      });
    }
  }
  return began;
}
