import {
  addLocalDays,
  localDate,
  turnOnType,
  zonedDateToUtc,
  type AppContext,
  type DeviceInfo,
  type TurnOn,
} from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";

import { keyOf, lightKey } from "../moods/light-states.js";
import { turnOnEntities } from "../moods/schema.js";
import { lightsOf } from "../moods/smart.js";
import { readMood, type Mood } from "../moods/store.js";
import { allLightsInRoom, type Light } from "../targets.js";
import {
  readSchedule,
  readSnapshot,
  readTurnOn,
  type Snapshot,
  type TurnOnBehaviour,
} from "./store.js";
import { day, minuteIn, spanAt } from "./times.js";

// What turning a room's lights on brings. The core turns a room, a zone or
// the home on, so Moods publishes each room's rule as a standard
// lights.turnOn entity, which the core reads by type at the press:
//
// - Following the schedule (the default): the scheduled mood while one
//   holds, its lights as it sets them and the room's others off, until
//   its end. Otherwise the lights that were on when the room last went
//   dark come back, each as it remembers itself, so a look the core holds
//   for one, such as natural light's, wins.
// - As they were: those lights with exactly the look they had, schedule
//   or not.
//
// A rule that would turn no light on is none, so the core switches the
// room on as it remembers its lights.

/** The instant a minute of the day next comes after now, in a time zone. */
export function nextAt(minute: number, timeZone: string, now: Date) {
  const today = localDate(timeZone, now);
  for (const days of [0, 1, 2]) {
    const date = addLocalDays(today, days + (minute === day ? 1 : 0));
    const at = zonedDateToUtc(
      date,
      Math.floor((minute % day) / 60),
      minute % 60,
      timeZone,
    );
    if (at > now) return at;
  }
  throw new Error(`No ${minute} after ${now.toISOString()} in ${timeZone}`);
}

/** What turning a room on does now, or null when the core's own way serves. */
export function turnOnRule(input: {
  roomId: string;
  behaviour: TurnOnBehaviour;
  /** Every light in the room, offline or not. */
  lights: readonly Light[];
  /** The scheduled mood that holds now, and when it ends. */
  scheduled: { mood: Mood; until: Date } | null;
  snapshot: Snapshot | null;
}): TurnOn | null {
  const { roomId, behaviour, lights, scheduled, snapshot } = input;
  const comesOn = (rule: TurnOn) => rule.lights.some((each) => each.state.on);
  if (behaviour === "followSchedule" && scheduled) {
    const own = new Map(
      lightsOf(scheduled.mood, lights).map((each) => [
        lightKey(each.device, each.capability),
        each.state,
      ]),
    );
    const rule: TurnOn = {
      placeId: roomId,
      lights: lights.map((light) => ({
        device: light.device.id,
        capability: light.capability.id,
        state: own.get(keyOf(light)) ?? { on: false },
      })),
      until: scheduled.until.toISOString(),
    };
    if (comesOn(rule)) return rule;
  }
  if (!snapshot) return null;
  const inRoom = new Set(lights.map(keyOf));
  const rule: TurnOn = {
    placeId: roomId,
    lights: snapshot.lights
      .filter((each) => inRoom.has(lightKey(each.device, each.capability)))
      .map((each) => ({
        device: each.device,
        capability: each.capability,
        state:
          behaviour === "asTheyWere" || !each.state.on
            ? each.state
            : { on: true },
      })),
    until: null,
  };
  return comesOn(rule) ? rule : null;
}

/** A room's lights.turnOn, by Moods' own key for it. */
export const turnOnKey = (roomId: string) => `turn-on:${roomId}`;

async function ruleOf(
  ctx: AppContext,
  roomId: string,
  lights: readonly Light[],
  timeZone: string,
  now: Date,
) {
  const { db } = ctx.storage;
  const target = { kind: "room", id: roomId } as const;
  const entry = spanAt(await readSchedule(db, roomId), minuteIn(now, timeZone));
  const mood = entry ? await readMood(db, entry.moodId) : null;
  return turnOnRule({
    roomId,
    behaviour: await readTurnOn(db, target),
    lights,
    scheduled:
      entry && mood ? { mood, until: nextAt(entry.end, timeZone, now) } : null,
    snapshot: await readSnapshot(db, target),
  });
}

// One publication at a time, so a rule worked out before a change never
// lands after one worked out since.
let turn: Promise<unknown> = Promise.resolve();

/**
 * Publishes these rooms' lights.turnOn as they stand now, those that
 * changed only, and takes out the ones that are none any more. Without
 * rooms it publishes every room's again and takes out those of rooms that
 * are gone, as on start.
 */
export function publishTurnOn(ctx: AppContext, rooms?: readonly string[]) {
  const mine = turn.then(() => publishNow(ctx, rooms && [...new Set(rooms)]));
  turn = mine.catch(() => undefined);
  return mine;
}

async function publishNow(ctx: AppContext, rooms?: readonly string[]) {
  if (rooms?.length === 0) return;
  const { db } = ctx.storage;
  const places = await ctx.places.list();
  const present = new Map(places.rooms.map((room) => [room.id, room]));
  const recorded = await db.select().from(turnOnEntities).all();
  const last = new Map(recorded.map((row) => [row.roomId, row]));
  const devices: DeviceInfo[] = await ctx.devices.list();
  const now = new Date();
  const wanted = rooms ?? [...new Set([...present.keys(), ...last.keys()])];
  for (const roomId of wanted) {
    const room = present.get(roomId);
    const lights = allLightsInRoom(devices, roomId);
    const state = room
      ? await ruleOf(ctx, roomId, lights, places.home.timeZone, now)
      : null;
    const kept = last.get(roomId);
    if (!state) {
      if (!kept) continue;
      await ctx.entities.remove(turnOnKey(roomId));
      await db.delete(turnOnEntities).where(eq(turnOnEntities.roomId, roomId));
      continue;
    }
    if (rooms && kept && isDeepStrictEqual(kept.state, state)) {
      continue;
    }
    // Recorded before it goes out, as moods' entities are.
    await db
      .insert(turnOnEntities)
      .values({ roomId, state: null })
      .onConflictDoUpdate({
        target: turnOnEntities.roomId,
        set: { state: null },
      });
    await ctx.entities.publish({
      type: turnOnType.id,
      key: turnOnKey(roomId),
      name: room!.name,
      state,
    });
    await db
      .update(turnOnEntities)
      .set({ state })
      .where(eq(turnOnEntities.roomId, roomId));
  }
}
