import { ActionError, type AppContext } from "@meetsanctum/app-sdk";
import { and, asc, eq, notInArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { MoodLight } from "../moods/light-states.js";
import {
  moods,
  scheduledMoods,
  snapshotLights,
  turnOnSettings,
} from "../moods/schema.js";
import { byStart, isEnd, isStart, overlaps, type Span } from "./times.js";

// Each room's schedule, how a room turns its lights on and the snapshot of
// them, in Moods' own database. A schedule is Moods' own, and its jobs run
// it (jobs.ts).

type Db = AppContext["storage"]["db"];

/**
 * How turning a target's lights on goes: following its schedule, the
 * default, or exactly as they were.
 */
export type TurnOnBehaviour = "followSchedule" | "asTheyWere";
export const turnOnBehaviours = ["followSchedule", "asTheyWere"] as const;

/** A room, a zone or the home. */
export type Target =
  | { kind: "room"; id: string }
  | { kind: "zone"; id: string }
  | { kind: "home" };

const keyOf = (target: Target) => ({
  targetKind: target.kind,
  targetId: target.kind === "home" ? "home" : target.id,
});

/** One of a room's scheduled moods. */
export type ScheduledMood = Span & {
  id: string;
  roomId: string;
  moodId: string;
};

/** The scheduled moods of a room, or of every room, in the order of the day. */
export async function readSchedule(
  db: Db,
  roomId?: string,
): Promise<ScheduledMood[]> {
  const rows = await db
    .select()
    .from(scheduledMoods)
    .where(roomId === undefined ? undefined : eq(scheduledMoods.roomId, roomId))
    .orderBy(asc(scheduledMoods.roomId), asc(scheduledMoods.start))
    .all();
  return byStart(rows);
}

/**
 * Schedules one of a room's moods, or moves or changes one already
 * scheduled: in 15-minute steps, with an end apart from its start, and
 * overlapping none of the room's others.
 */
export async function saveScheduledMood(
  db: Db,
  input: Omit<ScheduledMood, "id"> & { id?: string },
): Promise<ScheduledMood> {
  const { roomId, moodId, start, end } = input;
  // 00:00 to 24:00 is the whole day; any other end at its start is none.
  if (!isStart(start) || !isEnd(end) || start === end) {
    throw new ActionError(
      "conflict",
      "A start and an end in 15-minute steps, apart from each other",
    );
  }
  return db.transaction(async (tx) => {
    const mood = await tx
      .select({ roomId: moods.roomId })
      .from(moods)
      .where(eq(moods.id, moodId))
      .get();
    // A mood of this room.
    if (!mood || mood.roomId !== roomId) {
      throw new ActionError("not_found", "Not one of the room's moods");
    }
    if (input.id !== undefined) {
      const kept = await tx
        .select({ roomId: scheduledMoods.roomId })
        .from(scheduledMoods)
        .where(eq(scheduledMoods.id, input.id))
        .get();
      if (!kept || kept.roomId !== roomId) {
        throw new ActionError("not_found");
      }
    }
    const others = (
      await tx
        .select()
        .from(scheduledMoods)
        .where(eq(scheduledMoods.roomId, roomId))
        .all()
    ).filter((other) => other.id !== input.id);
    if (others.some((other) => overlaps(other, { start, end }))) {
      throw new ActionError("conflict", "It overlaps another scheduled mood");
    }
    const id = input.id ?? randomUUID();
    await tx
      .insert(scheduledMoods)
      .values({ id, roomId, moodId, start, end })
      .onConflictDoUpdate({
        target: scheduledMoods.id,
        set: { moodId, start, end },
      });
    return { id, roomId, moodId, start, end };
  });
}

/** Takes a mood off its room's schedule; its room, or null when there was none. */
export async function removeScheduledMood(
  db: Db,
  id: string,
): Promise<string | null> {
  const removed = await db
    .delete(scheduledMoods)
    .where(eq(scheduledMoods.id, id))
    .returning({ roomId: scheduledMoods.roomId })
    .get();
  return removed?.roomId ?? null;
}

/** How a target turns its lights on: following its schedule unless the household chose otherwise. */
export async function readTurnOn(
  db: Db,
  target: Target,
): Promise<TurnOnBehaviour> {
  const { targetKind, targetId } = keyOf(target);
  const row = await db
    .select({ behaviour: turnOnSettings.behaviour })
    .from(turnOnSettings)
    .where(
      and(
        eq(turnOnSettings.targetKind, targetKind),
        eq(turnOnSettings.targetId, targetId),
      ),
    )
    .get();
  return row?.behaviour === "asTheyWere" ? "asTheyWere" : "followSchedule";
}

/** Sets how a target turns its lights on. */
export async function setTurnOn(
  db: Db,
  target: Target,
  behaviour: TurnOnBehaviour,
) {
  const key = keyOf(target);
  await db
    .insert(turnOnSettings)
    .values({ ...key, behaviour })
    .onConflictDoUpdate({
      target: [turnOnSettings.targetKind, turnOnSettings.targetId],
      set: { behaviour },
    });
}

/** A target's lights as they were when it last went dark. */
export type Snapshot = { takenAt: string; lights: MoodLight[] };

/** A target's snapshot, or null before its first. */
export async function readSnapshot(
  db: Db,
  target: Target,
): Promise<Snapshot | null> {
  const { targetKind, targetId } = keyOf(target);
  const rows = await db
    .select()
    .from(snapshotLights)
    .where(
      and(
        eq(snapshotLights.targetKind, targetKind),
        eq(snapshotLights.targetId, targetId),
      ),
    )
    .orderBy(asc(snapshotLights.deviceId), asc(snapshotLights.capabilityId))
    .all();
  if (rows.length === 0) return null;
  return {
    takenAt: rows[0]!.takenAt,
    lights: rows.map((row) => ({
      device: row.deviceId,
      capability: row.capabilityId,
      state: row.state,
    })),
  };
}

/** Replaces a target's snapshot. */
export async function replaceSnapshot(
  db: Db,
  target: Target,
  snapshot: Snapshot,
) {
  const key = keyOf(target);
  await db.transaction(async (tx) => {
    await tx
      .delete(snapshotLights)
      .where(
        and(
          eq(snapshotLights.targetKind, key.targetKind),
          eq(snapshotLights.targetId, key.targetId),
        ),
      );
    if (snapshot.lights.length > 0) {
      await tx.insert(snapshotLights).values(
        snapshot.lights.map((light) => ({
          ...key,
          deviceId: light.device,
          capabilityId: light.capability,
          state: light.state,
          takenAt: snapshot.takenAt,
        })),
      );
    }
  });
}

/**
 * Forgets what Moods keeps for rooms other than these: their schedules,
 * how they turn on and their snapshots, as for rooms deleted while it was
 * stopped. A room's moods go with it in store.ts, its scheduled moods
 * with them.
 */
export async function keepRoomSchedules(db: Db, roomIds: readonly string[]) {
  const kept = [...roomIds];
  await db
    .delete(scheduledMoods)
    .where(kept.length ? notInArray(scheduledMoods.roomId, kept) : undefined);
  await db
    .delete(turnOnSettings)
    .where(
      and(
        eq(turnOnSettings.targetKind, "room"),
        kept.length ? notInArray(turnOnSettings.targetId, kept) : undefined,
      ),
    );
  await db
    .delete(snapshotLights)
    .where(
      and(
        eq(snapshotLights.targetKind, "room"),
        kept.length ? notInArray(snapshotLights.targetId, kept) : undefined,
      ),
    );
}

/** Forgets a deleted room's schedule, how it turned on and its snapshot. */
export async function removeRoomSchedules(db: Db, roomId: string) {
  await db.delete(scheduledMoods).where(eq(scheduledMoods.roomId, roomId));
  await db
    .delete(turnOnSettings)
    .where(
      and(
        eq(turnOnSettings.targetKind, "room"),
        eq(turnOnSettings.targetId, roomId),
      ),
    );
  await db
    .delete(snapshotLights)
    .where(
      and(
        eq(snapshotLights.targetKind, "room"),
        eq(snapshotLights.targetId, roomId),
      ),
    );
}
