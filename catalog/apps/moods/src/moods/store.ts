import { ActionError, type AppContext } from "@meetsanctum/app-sdk";
import { and, asc, eq, inArray, max, notInArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { MoodIcon } from "./icons.js";
import type { MoodLight } from "./light-states.js";
import { moodLights, moods } from "./schema.js";
import { smartDefinition, type SmartSettings } from "./smart.js";

// Moods in the app's own database, ported from v1's moods-db.ts (Pragmata
// v1-final). A mood belongs to one room and sits in its room's order,
// custom and smart ones alike; deleting it deletes its lights, and a room's
// moods go with the room.

type Db = AppContext["storage"]["db"];

/** A smart mood's definition and settings. */
export type SmartMood = SmartSettings & { definition: string };

export type Mood = {
  id: string;
  roomId: string;
  name: string;
  icon: MoodIcon;
  /** A custom mood's lights; none for a smart one. */
  lights: MoodLight[];
  /** A smart mood's, null for a custom one. */
  smart: SmartMood | null;
};

type MoodRow = typeof moods.$inferSelect;
type LightRow = typeof moodLights.$inferSelect;

function expand(row: MoodRow, lights: readonly LightRow[]): Mood {
  // A smart mood takes its name and icon from the catalog as it is now.
  const definition =
    row.definitionId === null ? undefined : smartDefinition(row.definitionId);
  return {
    id: row.id,
    roomId: row.roomId,
    name: definition?.name ?? row.name,
    icon: definition?.icon ?? (row.icon as MoodIcon),
    smart:
      row.definitionId === null
        ? null
        : {
            definition: row.definitionId,
            brightness: row.brightness ?? definition?.brightness ?? 100,
            off: row.offLights ?? [],
          },
    lights: lights
      .filter((light) => light.moodId === row.id)
      .map((light) => ({
        device: light.deviceId,
        capability: light.capabilityId,
        state: light.state,
      })),
  };
}

const lightRows = (moodId: string, lights: readonly MoodLight[]) =>
  lights.map((light) => ({
    moodId,
    deviceId: light.device,
    capabilityId: light.capability,
    state: light.state,
  }));

/** The moods of one room, or of every room, each room's in its order. */
export async function readMoods(db: Db, roomId?: string): Promise<Mood[]> {
  const rows = await db
    .select()
    .from(moods)
    .where(roomId === undefined ? undefined : eq(moods.roomId, roomId))
    .orderBy(asc(moods.roomId), asc(moods.position))
    .all();
  if (rows.length === 0) return [];
  const lights = await db
    .select()
    .from(moodLights)
    .where(
      inArray(
        moodLights.moodId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(moodLights.deviceId), asc(moodLights.capabilityId))
    .all();
  return rows.map((row) => expand(row, lights));
}

export async function readMood(db: Db, id: string): Promise<Mood | null> {
  const row = await db.select().from(moods).where(eq(moods.id, id)).get();
  if (!row) return null;
  const lights = await db
    .select()
    .from(moodLights)
    .where(eq(moodLights.moodId, id))
    .orderBy(asc(moodLights.deviceId), asc(moodLights.capabilityId))
    .all();
  return expand(row, lights);
}

/** Adds a custom mood, or assigns a smart one, after its room's others. */
export async function insertMood(
  db: Db,
  input: Omit<Mood, "id" | "smart"> & { smart?: SmartMood },
): Promise<Mood> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    const last = await tx
      .select({ position: max(moods.position) })
      .from(moods)
      .where(eq(moods.roomId, input.roomId))
      .get();
    if (input.smart) {
      // v1's assertSmartMoodAssignmentIsUnique.
      const taken = await tx
        .select({ id: moods.id })
        .from(moods)
        .where(
          and(
            eq(moods.roomId, input.roomId),
            eq(moods.definitionId, input.smart.definition),
          ),
        )
        .get();
      if (taken) {
        throw new ActionError("conflict", "The room has this smart mood");
      }
    }
    await tx.insert(moods).values({
      id,
      roomId: input.roomId,
      name: input.name,
      icon: input.icon,
      position: (last?.position ?? -1) + 1,
      ...(input.smart && {
        definitionId: input.smart.definition,
        brightness: input.smart.brightness,
        offLights: [...input.smart.off],
      }),
    });
    if (input.lights.length > 0) {
      await tx.insert(moodLights).values(lightRows(id, input.lights));
    }
  });
  const mood = await readMood(db, id);
  if (!mood) throw new ActionError("not_found");
  return mood;
}

/** Changes a smart mood's brightness or the lights it leaves off (v1's updateSmartMoodAssignment). */
export async function changeSmartMood(
  db: Db,
  id: string,
  patch: Partial<SmartSettings>,
): Promise<Mood> {
  const found = await db
    .select({ definitionId: moods.definitionId })
    .from(moods)
    .where(eq(moods.id, id))
    .get();
  if (!found) throw new ActionError("not_found");
  if (found.definitionId === null) {
    throw new ActionError("conflict", "The mood is not a smart mood");
  }
  await db
    .update(moods)
    .set({
      brightness: patch.brightness,
      offLights: patch.off && [...patch.off],
    })
    .where(eq(moods.id, id));
  const mood = await readMood(db, id);
  if (!mood) throw new ActionError("not_found");
  return mood;
}

/** Changes a custom mood's name, icon or lights; its room stays. */
export async function changeMood(
  db: Db,
  id: string,
  patch: Partial<Pick<Mood, "name" | "icon" | "lights">>,
): Promise<Mood> {
  await db.transaction(async (tx) => {
    const found = await tx
      .select({ definitionId: moods.definitionId })
      .from(moods)
      .where(eq(moods.id, id))
      .get();
    if (!found) throw new ActionError("not_found");
    // A smart mood's name, icon and lights come from its definition.
    if (found.definitionId !== null) {
      throw new ActionError(
        "conflict",
        "A smart mood takes its name, icon and lights from the catalog",
      );
    }
    if (patch.name !== undefined || patch.icon !== undefined) {
      await tx
        .update(moods)
        .set({ name: patch.name, icon: patch.icon })
        .where(eq(moods.id, id));
    }
    if (patch.lights !== undefined) {
      await tx.delete(moodLights).where(eq(moodLights.moodId, id));
      await tx.insert(moodLights).values(lightRows(id, patch.lights));
    }
  });
  const mood = await readMood(db, id);
  if (!mood) throw new ActionError("not_found");
  return mood;
}

/** Deletes a mood and its lights; its room, or null when there was none. */
export async function removeMood(db: Db, id: string): Promise<string | null> {
  const deleted = await db
    .delete(moods)
    .where(eq(moods.id, id))
    .returning({ roomId: moods.roomId })
    .get();
  return deleted?.roomId ?? null;
}

/** Deletes a room's moods, smart ones too, with their lights. */
export async function removeRoomMoods(db: Db, roomId: string) {
  await db.delete(moods).where(eq(moods.roomId, roomId));
}

/** Deletes the moods of every room but these, as for rooms deleted while Moods was stopped. */
export async function keepRoomMoods(db: Db, roomIds: readonly string[]) {
  await db
    .delete(moods)
    .where(roomIds.length ? notInArray(moods.roomId, [...roomIds]) : undefined);
}

/**
 * Puts a room's moods in order (v1's saveMoodTargetOrder): those named
 * first, as named, then the rest as they were. Each must be one of the
 * room's moods.
 */
export async function reorderMoods(
  db: Db,
  roomId: string,
  moodIds: readonly string[],
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: moods.id })
      .from(moods)
      .where(eq(moods.roomId, roomId))
      .orderBy(asc(moods.position))
      .all();
    const current = rows.map((row) => row.id);
    if (moodIds.some((id) => !current.includes(id))) {
      throw new ActionError("not_found", "Not one of the room's moods");
    }
    const order = [
      ...moodIds,
      ...current.filter((id) => !moodIds.includes(id)),
    ];
    for (const [position, id] of order.entries()) {
      await tx
        .update(moods)
        .set({ position })
        .where(and(eq(moods.id, id), eq(moods.roomId, roomId)));
    }
    return order;
  });
}
