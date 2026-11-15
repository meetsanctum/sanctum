import {
  ActionError,
  defineEntityType,
  isActionError,
  type AppContext,
  type CapabilityInfo,
  type DeviceInfo,
} from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  followed,
  followedRow,
  homeSun,
  isPaused,
  lookFor,
  publish,
  takesColorTemperature,
  type FollowOptions,
  type RunForLight,
} from "./lights.js";
import { followedLights, roomButtons } from "./schema.js";
import { targetKey } from "./target.js";

// Natural light's button for each room, beside the room's button for all its
// lights, on its page and on Home: a room section of buttons, drawn by the
// shell from a `naturalLight.room` entity for each room where a light
// follows. It shows only while natural light is on and the home has a
// location.
//
// It is White while every light in the room that is on follows the curve,
// unpaused, and at least one is on; lights that are off don't count, but a
// light that is on and doesn't follow does. A press while it is White
// switches every light in the room off. Otherwise it brings the room to
// natural light: every light that follows comes on at the curve, any pause
// ended, and every other light that is on goes off, so the room looks the
// same after every press. Offline lights are left alone and don't count.

export const roomState = z.object({
  placeId: z.string(),
  icon: z.enum(["sun"]),
  name: z.string(),
  order: z.number().int().min(0),
  active: z.boolean(),
  input: z.object({ placeId: z.string() }),
});
export type RoomState = z.infer<typeof roomState>;

export const roomType = defineEntityType({
  id: "naturalLight.room",
  title: "Natural light in a room",
  state: roomState,
});

/** A room button's key. Targets' keys have a slash, so none is one. */
export const roomKey = (placeId: string) => `room:${placeId}`;

type Followed = typeof followedLights.$inferSelect;
type RoomLight = {
  device: DeviceInfo;
  capability: Extract<CapabilityInfo, { kind: "light" }>;
};

const keyOf = (light: RoomLight) =>
  targetKey(light.device.id, light.capability.id);

/** A room's lights that answer. */
function lightsIn(devices: readonly DeviceInfo[], placeId: string) {
  return devices.flatMap((device) =>
    device.roomId === placeId && device.availability !== "offline"
      ? device.capabilities.flatMap((capability) =>
          capability.kind === "light" ? [{ device, capability }] : [],
        )
      : [],
  );
}

/** A room's button, or none for a room where no light follows. */
export function roomStateOf(
  placeId: string,
  devices: readonly DeviceInfo[],
  rows: ReadonlyMap<string, Followed>,
  appId: string,
): RoomState | null {
  const follows = (light: RoomLight) =>
    takesColorTemperature(light.capability) && rows.has(keyOf(light));
  const all = devices.flatMap((device) =>
    device.roomId === placeId
      ? device.capabilities.flatMap((capability) =>
          capability.kind === "light" ? [{ device, capability }] : [],
        )
      : [],
  );
  if (!all.some(follows)) return null;
  const on = lightsIn(devices, placeId).filter(
    (light) => light.capability.state?.on === true,
  );
  const active =
    on.length > 0 &&
    on.every(
      (light) =>
        follows(light) &&
        !isPaused(rows.get(keyOf(light))!, light.capability, appId),
    );
  return {
    placeId,
    icon: "sun",
    name: "Natural light",
    order: 0,
    active,
    input: { placeId },
  };
}

async function rowsOf(ctx: AppContext) {
  const rows = await ctx.storage.db.select().from(followedLights);
  return new Map(
    rows.map((row) => [targetKey(row.deviceId, row.capabilityId), row]),
  );
}

// One publication at a time, so a button worked out before a change never
// lands after one worked out since.
let turn: Promise<unknown> = Promise.resolve();

/**
 * Publishes these rooms' buttons as they stand now, those that changed
 * only, and takes out those that are none any more. Without rooms it does
 * every room with a light and every room it published a button for, and
 * with `always` it publishes each again whether or not it changed, as on
 * start.
 */
export function publishRooms(
  ctx: AppContext,
  options: FollowOptions,
  which?: { rooms?: readonly (string | null)[]; always?: boolean },
) {
  const mine = turn.then(() => publishNow(ctx, options, which ?? {}));
  turn = mine.catch(() => undefined);
  return mine;
}

async function publishNow(
  ctx: AppContext,
  options: FollowOptions,
  which: { rooms?: readonly (string | null)[]; always?: boolean },
) {
  const { db } = ctx.storage;
  const rooms = which.rooms?.filter((room): room is string => room !== null);
  if (rooms?.length === 0) return;
  const recorded = new Map(
    (await db.select().from(roomButtons)).map((row) => [row.placeId, row]),
  );
  const devices = await ctx.devices.list();
  const shows = options.isOn && (await homeSun(ctx, options.now())) !== null;
  const rows = shows ? await rowsOf(ctx) : new Map<string, Followed>();
  const wanted = rooms ?? [
    ...new Set([
      ...devices.flatMap((device) => (device.roomId ? [device.roomId] : [])),
      ...recorded.keys(),
    ]),
  ];
  for (const placeId of new Set(wanted)) {
    const state = shows ? roomStateOf(placeId, devices, rows, ctx.appId) : null;
    const kept = recorded.get(placeId);
    if (!state) {
      if (!kept) continue;
      await ctx.entities.remove(roomKey(placeId));
      await db.delete(roomButtons).where(eq(roomButtons.placeId, placeId));
      continue;
    }
    if (!which.always && kept && isDeepStrictEqual(kept.state, state)) {
      continue;
    }
    // Recorded before it goes out, so a failed publication is tried again.
    await db
      .insert(roomButtons)
      .values({ placeId, state: null })
      .onConflictDoUpdate({
        target: roomButtons.placeId,
        set: { state: null },
      });
    await ctx.entities.publish({
      type: roomType.id,
      key: roomKey(placeId),
      name: "Natural light",
      state,
    });
    await db
      .update(roomButtons)
      .set({ state })
      .where(eq(roomButtons.placeId, placeId));
  }
}

/** A light the press could not reach, which the shell fails on its tile. */
export type Failed = { device: string; capability: string };

async function eachLight(
  ctx: AppContext,
  runForLight: RunForLight,
  lights: readonly RoomLight[],
  work: (light: RoomLight) => Promise<void>,
): Promise<Failed[]> {
  const failed: Failed[] = [];
  for (const light of lights) {
    const each = { device: light.device.id, capability: light.capability.id };
    try {
      await runForLight(each.device, each.capability, () => work(light));
    } catch (error) {
      ctx.log(
        `could not set ${light.device.name} (${isActionError(error) ? error.code : error instanceof Error ? error.message : String(error)})`,
      );
      failed.push(each);
    }
  }
  return failed;
}

/** Switches every light in the room that is on off. */
export async function switchRoomOff(
  ctx: AppContext,
  runForLight: RunForLight,
  placeId: string,
): Promise<Failed[]> {
  const lights = lightsIn(await ctx.devices.list(), placeId).filter(
    (light) => light.capability.state?.on === true,
  );
  return eachLight(ctx, runForLight, lights, async (light) => {
    await ctx.devices.command({
      device: light.device.id,
      capability: light.capability.id,
      command: { on: false },
    });
  });
}

/**
 * Brings the room to natural light: every light that follows on at the
 * curve, its pause ended, and every other light that is on off.
 */
export async function bringRoom(
  ctx: AppContext,
  options: FollowOptions,
  runForLight: RunForLight,
  placeId: string,
): Promise<Failed[]> {
  if (!options.isOn) {
    throw new ActionError("conflict", "Natural light is switched off");
  }
  const now = options.now();
  const sun = await homeSun(ctx, now);
  if (!sun) {
    throw new ActionError(
      "conflict",
      "Natural light waits for the home's location",
    );
  }
  const lights = lightsIn(await ctx.devices.list(), placeId);
  return eachLight(ctx, runForLight, lights, async (light) => {
    const { device, capability } = light;
    const row = await followedRow(ctx, device.id, capability.id);
    const look =
      row && takesColorTemperature(capability)
        ? lookFor(options.curve, sun, capability, now)
        : null;
    if (!look) {
      if (capability.state?.on !== true) return;
      await ctx.devices.command({
        device: device.id,
        capability: capability.id,
        command: { on: false },
      });
      return;
    }
    await ctx.devices.command({
      device: device.id,
      capability: capability.id,
      command: { on: true, ...look },
    });
    await ctx.storage.db
      .update(followedLights)
      .set({ since: now, pausedAt: null, applied: look, appliedAt: now })
      .where(followed(device.id, capability.id));
    await publish(ctx, light, {
      device: device.id,
      capability: capability.id,
      status: "following",
      colorTemperature: look.colorTemperature,
      brightness: look.brightness ?? null,
    });
  });
}

/**
 * A press of a room's button: off while the room is on natural light,
 * otherwise to natural light.
 */
export async function toggleRoom(
  ctx: AppContext,
  options: FollowOptions,
  runForLight: RunForLight,
  placeId: string,
): Promise<Failed[]> {
  const state = roomStateOf(
    placeId,
    await ctx.devices.list(),
    await rowsOf(ctx),
    ctx.appId,
  );
  return state?.active
    ? switchRoomOff(ctx, runForLight, placeId)
    : bringRoom(ctx, options, runForLight, placeId);
}
