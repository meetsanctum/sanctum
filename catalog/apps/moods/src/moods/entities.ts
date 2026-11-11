import {
  defineEntityType,
  type AppContext,
  type DeviceEvent,
  type DeviceInfo,
} from "@meetsanctum/app-sdk";
import { eq, inArray } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { lightsInRoom } from "../targets.js";
import { moodIcons } from "./icons.js";
import { activeMood } from "./light-states.js";
import { moodEntities } from "./schema.js";
import { lightsOf } from "./smart.js";
import { readMoods, type Mood } from "./store.js";

// What Moods brings to the home: a `moods.mood` entity for each mood, in the
// tile shape a room section draws, with whether the room's lights show it
// now. Which one they show is the rule Moods' pages use (light-states.ts):
// offline lights do not count, and when several moods match, none is active.
// One state serves every viewer.

export const moodState = z.object({
  /** The mood's room. */
  placeId: z.string(),
  icon: z.enum(moodIcons),
  name: z.string(),
  /** Its place among the room's moods, from 0. */
  order: z.number().int().min(0),
  /** Whether the room's lights show it now. */
  active: z.boolean(),
  /** What moods.runMood takes to run it. */
  input: z.object({ id: z.string() }),
});
export type MoodState = z.infer<typeof moodState>;

export const moodType = defineEntityType({
  id: "moods.mood",
  title: "Mood",
  state: moodState,
});

// One publication at a time, so a room read before a change never lands
// after one read since: a mood saved while its preview's lights still
// report, say.
let turn: Promise<unknown> = Promise.resolve();

function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const mine = turn.then(work);
  turn = mine.catch(() => undefined);
  return mine;
}

/**
 * Publishes the moods of these rooms as they stand now, those whose state
 * changed only, and takes out the entities of their moods that are gone.
 * Without rooms it publishes every mood again, in case the home missed
 * one, as on start.
 */
export function publishMoods(ctx: AppContext, rooms?: readonly string[]) {
  return inTurn(() => publishNow(ctx, rooms && [...new Set(rooms)]));
}

async function publishNow(ctx: AppContext, rooms?: readonly string[]) {
  if (rooms?.length === 0) return;
  const { db } = ctx.storage;
  const moods = rooms
    ? (await Promise.all(rooms.map((room) => readMoods(db, room)))).flat()
    : await readMoods(db);
  const published = await db
    .select()
    .from(moodEntities)
    .where(rooms && inArray(moodEntities.roomId, [...rooms]))
    .all();
  const last = new Map(published.map((row) => [row.moodId, row]));

  if (moods.length > 0) {
    const devices = await ctx.devices.list();
    for (const [roomId, own] of byRoom(moods)) {
      const inRoom = lightsInRoom(devices, roomId);
      const active = activeMood(
        own.map((mood) => ({ id: mood.id, lights: lightsOf(mood, inRoom) })),
        inRoom,
      );
      for (const [order, mood] of own.entries()) {
        const state: MoodState = {
          placeId: roomId,
          icon: mood.icon,
          name: mood.name,
          order,
          active: mood.id === active,
          input: { id: mood.id },
        };
        const kept = last.get(mood.id);
        if (rooms && kept && isDeepStrictEqual(kept.state, state)) {
          continue;
        }
        // Track the key before it goes out, so every entity that may be
        // in the home has a row to take it out by. A null state means the
        // publication still needs confirmation and must be retried.
        await db
          .insert(moodEntities)
          .values({ moodId: mood.id, roomId, state: null })
          .onConflictDoUpdate({
            target: moodEntities.moodId,
            set: { roomId, state: null },
          });
        await ctx.entities.publish({
          type: moodType.id,
          key: mood.id,
          name: mood.name,
          state,
        });
        await db
          .update(moodEntities)
          .set({ state })
          .where(eq(moodEntities.moodId, mood.id));
      }
    }
  }

  const present = new Set(moods.map((mood) => mood.id));
  for (const { moodId } of published) {
    if (present.has(moodId)) continue;
    await ctx.entities.remove(moodId);
    await db.delete(moodEntities).where(eq(moodEntities.moodId, moodId));
  }
}

// readMoods gives each room's moods together, in their order.
function byRoom(moods: readonly Mood[]) {
  const rooms = new Map<string, Mood[]>();
  for (const mood of moods) {
    rooms.set(mood.roomId, [...(rooms.get(mood.roomId) ?? []), mood]);
  }
  return rooms;
}

const hasLight = (device: DeviceInfo) =>
  device.capabilities.some((capability) => capability.kind === "light");

/**
 * The rooms whose moods a device's event may change: the room a light is
 * in and the one it left. A light that comes, goes, changes, goes offline
 * or moves changes what its rooms' lights show.
 */
export function roomsOf(event: DeviceEvent): string[] {
  const seen = event.name === "device.changed" ? [event.before] : [];
  return [event.device, ...seen].flatMap((device) =>
    hasLight(device) && device.roomId ? [device.roomId] : [],
  );
}
