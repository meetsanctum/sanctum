import type { AppContext } from "@meetsanctum/app-sdk";

import { publishMoods } from "./moods/entities.js";
import { syncPresses } from "./presses/presses.js";
import { syncJobs } from "./schedules/jobs.js";
import { publishTurnOn } from "./schedules/turn-on.js";

// Publications describe the whole room, so a change to one of its moods or
// its schedule publishes it again.
export async function refreshRoom(ctx: AppContext, roomId: string) {
  await publishMoods(ctx, [roomId]);
  await syncJobs(ctx);
  await publishTurnOn(ctx, [roomId]);
  await syncPresses(ctx);
}
