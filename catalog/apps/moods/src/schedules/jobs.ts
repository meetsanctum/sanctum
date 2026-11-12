import { defineAction, type AppContext } from "@meetsanctum/app-sdk";
import { z } from "zod";

import { failedLight, sendCommands } from "../lights.js";
import {
  keyOf,
  lightKey,
  moodCommands,
  showsState,
} from "../moods/light-states.js";
import { lightsOf } from "../moods/smart.js";
import { readMood } from "../moods/store.js";
import { lightsInRoom } from "../targets.js";
import { readSchedule } from "./store.js";
import { publishTurnOn } from "./turn-on.js";
import { day, formatMinute } from "./times.js";

// A room's schedule runs as Moods' jobs: a daily one at each start and end
// of its scheduled moods, in the home's time, as v1 ran it from a system
// automation's time triggers (room-schedule-runtime.ts, Pragmata v1-final).
// At a start the mood comes on if a light in the room is on, as Moods, so
// natural light pauses for its lights as for any mood. At an end with none
// following, Moods lets go of the lights that still show it: it switches
// them on again with no look, which tells whoever follows a light that no
// one holds its look any more, so natural light takes it back, as v1's did
// once the schedule moved on. A light someone changed meanwhile stays as
// they set it. Each run publishes the room's lights.turnOn again
// (turn-on.ts).

const jobPrefix = "schedule:";
const jobKey = (roomId: string, minute: number) =>
  `${jobPrefix}${roomId}:${minute}`;

const on = (state: { on: boolean } | null) => state?.on === true;

export const applySchedule = defineAction({
  id: "moods.applySchedule",
  title: "Run a room's schedule",
  tier: "write",
  input: z.object({
    roomId: z.string().min(1),
    minute: z.number().int().min(0).max(1439),
  }),
  output: z.object({
    ran: z.enum(["mood", "letGo", "nothing"]),
    switched: z.number().int(),
    failed: z.array(failedLight),
  }),
  async run(ctx, { roomId, minute }) {
    const { db } = ctx.storage;
    const schedule = await readSchedule(db, roomId);
    const started = schedule.find((each) => each.start === minute);
    const ended = schedule.find((each) => each.end % day === minute);
    const inRoom = lightsInRoom(await ctx.devices.list(), roomId);
    let result = {
      ran: "nothing" as "mood" | "letGo" | "nothing",
      switched: 0,
      failed: [] as z.infer<typeof failedLight>[],
    };
    const mood = await readMood(db, (started ?? ended)?.moodId ?? "");
    if (mood && started) {
      // v1 left a room that is off as it was.
      if (inRoom.some((light) => on(light.capability.state))) {
        const { sent, failed } = await sendCommands(
          ctx,
          moodCommands(lightsOf(mood, inRoom), inRoom),
        );
        result = { ran: "mood", switched: sent, failed };
      }
    } else if (mood && ended) {
      const wanted = new Map(
        lightsOf(mood, inRoom).map((each) => [
          lightKey(each.device, each.capability),
          each.state,
        ]),
      );
      const held = inRoom.filter((light) => {
        const state = wanted.get(keyOf(light));
        return state?.on === true && showsState(light.capability.state, state);
      });
      if (held.length > 0) {
        const { sent, failed } = await sendCommands(
          ctx,
          held.map((light) => ({ light, command: { on: true } })),
        );
        result = { ran: "letGo", switched: sent, failed };
      }
    }
    await publishTurnOn(ctx, [roomId]);
    return result;
  },
});

// One reconciliation at a time, so two saves never schedule over each
// other's.
let turn: Promise<unknown> = Promise.resolve();

/**
 * Keeps a daily job at every start and end of every room's scheduled
 * moods, and none else of the schedule's, as on start for times changed or
 * rooms deleted while Moods was stopped. With `all`, as on start, it
 * schedules those it has again too: after an update the core keeps only
 * the jobs the new version's start schedules, and one scheduled as it was
 * keeps its next run. With `fresh`, as when the home's time zone moves, it
 * schedules each again for a next run worked out afresh.
 */
export function syncJobs(
  ctx: AppContext,
  again: { all?: boolean; fresh?: boolean } = {},
) {
  const mine = turn.then(() => syncNow(ctx, again));
  turn = mine.catch(() => undefined);
  return mine;
}

async function syncNow(
  ctx: AppContext,
  { all = false, fresh = false }: { all?: boolean; fresh?: boolean },
) {
  const wanted = new Map<string, { roomId: string; minute: number }>();
  for (const { roomId, start, end } of await readSchedule(ctx.storage.db)) {
    for (const minute of [start, end % day]) {
      wanted.set(jobKey(roomId, minute), { roomId, minute });
    }
  }
  const kept = (await ctx.jobs.list()).filter((job) =>
    job.key.startsWith(jobPrefix),
  );
  for (const job of kept) {
    if (!wanted.has(job.key)) await ctx.jobs.cancel(job.key);
  }
  const have = new Set(kept.map((job) => job.key));
  for (const [key, input] of wanted) {
    if (have.has(key) && !all && !fresh) continue;
    await ctx.jobs.schedule({
      key,
      action: applySchedule,
      input,
      when: { daily: formatMinute(input.minute) },
      ...(fresh ? { fresh: true } : {}),
    });
  }
}
