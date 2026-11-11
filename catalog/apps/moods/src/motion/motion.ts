import {
  readPermission,
  workflowsManagePermission,
  type AppContext,
  type DeviceInfo,
  type KeptWorkflowRequest,
  type WorkflowGraph,
  type WorkflowNode,
} from "@meetsanctum/app-sdk";
import { eq, notInArray } from "drizzle-orm";

import { motionSettings } from "../moods/schema.js";
import {
  lightSensorsIn,
  stillRoom,
  type MotionChange,
  type RoomMotion,
} from "./room-motion.js";

// What motion does to a room's lights: the household chooses on Moods' page
// for the room, Moods keeps the choice, and from it a workflow for each
// switch, built from the core's own pieces only. With motion in the room
// while every light there is off, and darker than the level chosen, the
// core's lights step turns the room on, so it brings what the room's
// lights.turnOn does: the scheduled mood, or the lights as they were. With
// no motion for the minutes chosen while any light there is on, it turns
// them all off. A room whose sensors read no light level leaves the level
// out, as there is nothing to compare. Moods works the workflows out again
// whenever the choices, a room, a light sensor or its permissions change,
// and only then puts or removes them, as it does for remotes' presses
// (presses/). Motion pauses while Moods may not read motion sensors, and
// turning on only when it is dark pauses while it may not read light levels,
// rather than turning lights on whatever the light: their workflows go and
// the choices stay. Without its own automations it changes none of them.

type Db = AppContext["storage"]["db"];

// The keys Moods keeps the workflows by.
export const turnOnKey = (roomId: string) => `motion-on:${roomId}`;
export const turnOffKey = (roomId: string) => `motion-off:${roomId}`;
const isMotionKey = (key: string) =>
  key.startsWith("motion-on:") || key.startsWith("motion-off:");

/** What motion does to every room that chose, or to one room. */
export async function readMotion(
  db: Db,
  roomId?: string,
): Promise<RoomMotion[]> {
  return db
    .select()
    .from(motionSettings)
    .where(roomId === undefined ? undefined : eq(motionSettings.roomId, roomId))
    .all();
}

/** What motion does to a room's lights: nothing until it chooses. */
export async function roomMotion(db: Db, roomId: string): Promise<RoomMotion> {
  return (await readMotion(db, roomId))[0] ?? stillRoom(roomId);
}

/** Changes what motion does to a room, the rest kept as it was. */
export async function changeMotion(
  db: Db,
  roomId: string,
  change: MotionChange | Omit<RoomMotion, "roomId">,
) {
  await db
    .insert(motionSettings)
    .values({ ...stillRoom(roomId), ...change })
    .onConflictDoUpdate({ target: motionSettings.roomId, set: change });
}

/** Forgets what motion does to rooms other than these, as for rooms deleted while Moods was stopped. */
export async function keepRoomMotion(db: Db, roomIds: readonly string[]) {
  await db
    .delete(motionSettings)
    .where(
      roomIds.length
        ? notInArray(motionSettings.roomId, [...roomIds])
        : undefined,
    );
}

/** Forgets what motion did to a deleted room. */
export async function removeRoomMotion(db: Db, roomId: string) {
  await db.delete(motionSettings).where(eq(motionSettings.roomId, roomId));
}

// One node after another, each leading to the next.
function chain(nodes: WorkflowNode[]): WorkflowGraph {
  return {
    version: 1,
    nodes,
    edges: nodes
      .slice(1)
      .map((node, index) => ({ from: nodes[index]!.id, to: node.id })),
  };
}

/**
 * Motion in the room, while every light there is off and, with a level,
 * the room is darker than it: the room's lights on, as turning it on brings.
 */
export function turnOnGraph(roomId: string, darkerThan: number | null) {
  const place = { kind: "room", id: roomId };
  return chain([
    { id: "motion", kind: "trigger", piece: "motion", config: { place } },
    {
      id: "allOff",
      kind: "condition",
      piece: "lights",
      config: { place, are: "allOff" },
    },
    ...(darkerThan === null
      ? []
      : [
          {
            id: "darker",
            kind: "condition" as const,
            piece: "lightLevel",
            config: { place, is: "darker", lux: darkerThan },
          },
        ]),
    { id: "on", kind: "step", piece: "lights", config: { place, to: "on" } },
  ]);
}

/** No motion in the room for these minutes, while any light there is on: every light off. */
export function turnOffGraph(roomId: string, forMinutes: number) {
  const place = { kind: "room", id: roomId };
  return chain([
    {
      id: "quiet",
      kind: "trigger",
      piece: "noMotion",
      config: { place, forMinutes },
    },
    {
      id: "anyOn",
      kind: "condition",
      piece: "lights",
      config: { place, are: "anyOn" },
    },
    { id: "off", kind: "step", piece: "lights", config: { place, to: "off" } },
  ]);
}

// The room's name, then what the workflow does, within the core's limit.
function workflowName(roomName: string, does: string) {
  return `${roomName.slice(0, 120 - does.length - 1).trimEnd()} ${does}`;
}

/**
 * The workflows a room's choices ask for, by key. Without seeing light
 * levels, a room that turns on only below a level wants no turn-on.
 */
export function workflowsFor(
  motion: RoomMotion,
  room: { id: string; name: string },
  devices: readonly DeviceInfo[],
  { seesLight = true }: { seesLight?: boolean } = {},
): KeptWorkflowRequest[] {
  const wanted: KeptWorkflowRequest[] = [];
  if (motion.turnOn && (seesLight || motion.darkerThan === null)) {
    const readsLight = lightSensorsIn(devices, room.id).length > 0;
    wanted.push({
      key: turnOnKey(room.id),
      name: workflowName(room.name, "lights on with motion"),
      runMode: "single",
      graph: turnOnGraph(room.id, readsLight ? motion.darkerThan : null),
    });
  }
  if (motion.turnOffAfter !== null) {
    wanted.push({
      key: turnOffKey(room.id),
      name: workflowName(room.name, "lights off with no motion"),
      runMode: "single",
      graph: turnOffGraph(room.id, motion.turnOffAfter),
    });
  }
  return wanted;
}

async function sync(ctx: AppContext, roomId?: string) {
  const revision = await ctx.permissions.revision();
  const granted = await ctx.permissions.list();
  if (!granted.includes(workflowsManagePermission)) return;
  const seesMotion = granted.includes(readPermission("occupancy"));
  const seesLight = granted.includes(readPermission("sensor"));
  const db = ctx.storage.db;
  const [devices, places, chosen, kept] = await Promise.all([
    ctx.devices.list(),
    ctx.places.list(),
    readMotion(db, roomId),
    ctx.workflows.list(),
  ]);
  // Reads use the current grants, which may have changed while loading,
  // even if they changed back. Leave this snapshot alone:
  // permissions.changed queues a fresh sync.
  if ((await ctx.permissions.revision()) !== revision) return;
  const rooms = new Map(places.rooms.map((room) => [room.id, room]));
  const wanted = new Map<string, KeptWorkflowRequest>();
  for (const motion of chosen) {
    const room = rooms.get(motion.roomId);
    // A room deleted meanwhile takes its choices with it.
    if (!room) {
      await removeRoomMotion(db, motion.roomId);
      continue;
    }
    if (!seesMotion) continue;
    for (const workflow of workflowsFor(motion, room, devices, {
      seesLight,
    })) {
      wanted.set(workflow.key, workflow);
    }
  }
  for (const workflow of kept) {
    const key = workflow.appKey;
    const ours =
      key !== null &&
      (roomId === undefined
        ? isMotionKey(key)
        : key === turnOnKey(roomId) || key === turnOffKey(roomId));
    if (key && ours && !wanted.has(key)) {
      await ctx.workflows.remove(key);
    }
  }
  for (const { key, ...workflow } of wanted.values()) {
    await ctx.workflows.put(key, workflow);
  }
}

let syncing: Promise<void> = Promise.resolve();

function inSyncQueue(run: () => Promise<void>) {
  const next = syncing.then(run);
  syncing = next.catch(() => undefined);
  return next;
}

/** Change and reconcile together, putting the previous choices back on failure. */
export function changeAndSync(
  ctx: AppContext,
  roomId: string,
  change: MotionChange,
): Promise<void> {
  return inSyncQueue(async () => {
    const db = ctx.storage.db;
    const { roomId: _, ...previous } = await roomMotion(db, roomId);
    await changeMotion(db, roomId, change);
    try {
      await sync(ctx, roomId);
    } catch (error) {
      // Both databases cannot share a transaction, as for presses: put the
      // choices back and any workflow already changed, in the queue so a
      // later change is not undone, and report the first failure.
      try {
        await changeMotion(db, roomId, previous);
        await sync(ctx, roomId);
      } catch (rollback) {
        ctx.log(
          `could not put back what motion does in ${roomId} (${rollback instanceof Error ? rollback.message : String(rollback)})`,
        );
      }
      throw error;
    }
  });
}

/**
 * Brings the workflows Moods keeps for motion in line with the choices,
 * one sync at a time, so two never put and remove the same key at once.
 * A change to one room syncs only that room.
 */
export function syncMotion(ctx: AppContext, roomId?: string): Promise<void> {
  return inSyncQueue(() => sync(ctx, roomId));
}
