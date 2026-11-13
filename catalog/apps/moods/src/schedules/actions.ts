import {
  ActionError,
  defineAction,
  type AppContext,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { assertRoom, lightRef, roomId } from "../moods/actions.js";
import { applySchedule } from "./jobs.js";
import {
  readSchedule,
  readSnapshot,
  readTurnOn,
  removeScheduledMood,
  saveScheduledMood,
  setTurnOn,
  turnOnBehaviours,
} from "./store.js";
import { refreshRoom } from "../refresh.js";
import { day, step } from "./times.js";

// A room's schedule and how its lights turn on, shown and changed on
// Moods' page for the room. They are the household's, so everyone may read
// and change them, on a shared client too. Each change sets the schedule's
// jobs again (jobs.ts) and publishes the room's lights.turnOn (turn-on.ts).

const start = z
  .number()
  .int()
  .min(0)
  .max(day - step)
  .multipleOf(step);
const end = z.number().int().min(step).max(day).multipleOf(step);

export const scheduledMood = z.object({
  id: z.string(),
  roomId: z.string(),
  moodId: z.string(),
  start: z.number().int(),
  end: z.number().int(),
});

export const roomSchedule = z.object({
  roomId: z.string(),
  /** Its scheduled moods, in the order of the day. */
  scheduled: z.array(scheduledMood),
  turnOn: z.enum(turnOnBehaviours),
  /** When it last went dark, and the lights that were on then. */
  snapshot: z
    .object({ takenAt: z.string(), lights: z.array(lightRef) })
    .nullable(),
});
export type RoomSchedule = z.infer<typeof roomSchedule>;

async function scheduleOf(
  ctx: AppContext,
  room: string,
): Promise<RoomSchedule> {
  const { db } = ctx.storage;
  const target = { kind: "room", id: room } as const;
  const snapshot = await readSnapshot(db, target);
  return {
    roomId: room,
    scheduled: await readSchedule(db, room),
    turnOn: await readTurnOn(db, target),
    snapshot: snapshot && {
      takenAt: snapshot.takenAt,
      lights: snapshot.lights
        .filter((each) => each.state.on)
        .map(({ device, capability }) => ({ device, capability })),
    },
  };
}

async function changed(ctx: AppContext, room: string) {
  await refreshRoom(ctx, room);
  return scheduleOf(ctx, room);
}

export const listSchedules = defineAction({
  id: "moods.schedules",
  title: "Schedules",
  tier: "read",
  input: z.object({ roomId: roomId.optional() }),
  output: z.array(roomSchedule),
  async run(ctx, input) {
    const rooms = input.roomId
      ? [input.roomId]
      : (await ctx.places.list()).rooms.map((room) => room.id);
    return Promise.all(rooms.map((room) => scheduleOf(ctx, room)));
  },
});

export const scheduleMood = defineAction({
  id: "moods.scheduleMood",
  title: "Schedule a mood",
  tier: "write",
  input: z
    .object({
      /** One already scheduled, to change it; none schedules another. */
      id: z.string().min(1).optional(),
      roomId,
      moodId: z.string().min(1),
      start,
      end,
    })
    .refine((span) => span.start !== span.end, "an end apart from its start"),
  output: roomSchedule,
  async run(ctx, input) {
    await assertRoom(ctx, input.roomId);
    await saveScheduledMood(ctx.storage.db, input);
    return changed(ctx, input.roomId);
  },
});

export const unscheduleMood = defineAction({
  id: "moods.unscheduleMood",
  title: "Take a mood off the schedule",
  tier: "write",
  input: z.object({ id: z.string().min(1) }),
  output: roomSchedule,
  async run(ctx, input) {
    const room = await removeScheduledMood(ctx.storage.db, input.id);
    if (room === null) throw new ActionError("not_found");
    return changed(ctx, room);
  },
});

export const chooseTurnOn = defineAction({
  id: "moods.setTurnOn",
  title: "Choose how a room's lights turn on",
  tier: "write",
  input: z.object({ roomId, turnOn: z.enum(turnOnBehaviours) }),
  output: roomSchedule,
  async run(ctx, input) {
    await assertRoom(ctx, input.roomId);
    await setTurnOn(
      ctx.storage.db,
      { kind: "room", id: input.roomId },
      input.turnOn,
    );
    return changed(ctx, input.roomId);
  },
});

export const scheduleActions = [
  listSchedules,
  scheduleMood,
  unscheduleMood,
  chooseTurnOn,
  applySchedule,
];
