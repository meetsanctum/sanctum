import {
  isActionError,
  type AppContext,
  type LightCommand,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import type { Light } from "./targets.js";

// Sending a room's lights their commands at once, as running or previewing
// a mood does. Switching a place's lights together, and asking whether
// they are on, moved to the core, so they work without Moods.

/** A light a command could not reach. */
export const failedLight = z.object({
  device: z.string(),
  capability: z.string(),
});

/**
 * Sends each light its command at once, and names those that failed. A
 * light that went meanwhile is not a failure; a refusal for the person or
 * client behind the call refuses the whole call.
 */
export async function sendCommands(
  ctx: AppContext,
  commands: readonly { light: Light; command: LightCommand }[],
) {
  const results = await Promise.allSettled(
    commands.map(({ light, command }) =>
      ctx.devices.command({
        device: light.device.id,
        capability: light.capability.id,
        command,
      }),
    ),
  );
  let sent = 0;
  const failed: z.infer<typeof failedLight>[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      sent += 1;
      continue;
    }
    const { reason } = result;
    if (isActionError(reason)) {
      if (reason.code === "not_found") continue;
      throw reason;
    }
    const { light } = commands[index]!;
    failed.push({ device: light.device.id, capability: light.capability.id });
  }
  return { sent, failed };
}
