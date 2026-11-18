import {
  ActionError,
  defineEntityType,
  isActionError,
  turnOnType,
  type AppContext,
  type CapabilityInfo,
  type DeviceInfo,
  type TurnOn,
} from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  followed,
  followedRow,
  followOptionsFor,
  homeSun,
  pauseOf,
  lookFor,
  publish,
  takesColorTemperature,
  type FollowOptions,
  type RunForLight,
} from "./lights.js";
import { followedLights, roomButtons } from "./schema.js";
import { targetKey } from "./target.js";

// Natural light's tile for each room, in the room's row after its switch,
// on its page and on Home: a room section of buttons, a square tile with the
// sun, drawn by the shell from a `naturalLight.room` entity for each room
// where a light follows. It shows only while natural light is on and the
// home has a location.
//
// It is White while every light in the room that is on follows the curve,
// neither paused nor dimmed, and at least one is on; lights that are off
// don't count, but a light that is on and doesn't follow does. Natural light
// is a look, as a mood is, so a press never switches the room off: it brings
// the room to natural light, every light that follows on at the curve, any
// pause or dim ended, and every other light that is on off, so the room looks
// the same after every press. Leaving natural light is choosing a mood or
// switching the room off. Offline lights are left alone and don't count.
//
// Each such room also has natural light's rule for turning it on, a
// standard lights.turnOn ranked as a look: every light that follows comes
// on, at the look natural light holds for it while it is off, and every
// other light stays off. The core goes by it unless the household chose
// something firmer for the room, such as a scheduled mood, and before what
// was on when the room went dark.

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

/** A room's rule for turning it on, by its own key. */
export const turnOnKey = (placeId: string) => `turn-on:${placeId}`;

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
        pauseOf(rows.get(keyOf(light))!, light.capability, appId) === "none",
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

/** Natural light's rule for turning a room with a button on. */
export function turnOnOf(
  placeId: string,
  devices: readonly DeviceInfo[],
  rows: ReadonlyMap<string, Followed>,
): TurnOn {
  const lights = devices.flatMap((device) =>
    device.roomId === placeId
      ? device.capabilities.flatMap((capability) =>
          capability.kind === "light" ? [{ device, capability }] : [],
        )
      : [],
  );
  return {
    placeId,
    lights: lights.map((light) => ({
      device: light.device.id,
      capability: light.capability.id,
      state: {
        on: takesColorTemperature(light.capability) && rows.has(keyOf(light)),
      },
    })),
    until: null,
    rank: "look",
  };
}

async function rowsOf(ctx: AppContext) {
  const rows = await ctx.storage.db.select().from(followedLights);
  return new Map(
    rows.map((row) => [targetKey(row.deviceId, row.capabilityId), row]),
  );
}

/**
 * Which rooms a publication is for, all of them without `rooms`. `waits`
 * leaves a room as it is, asked as the publication reads the lights and as
 * each room's turn comes, since what a room waits for may begin while the
 * publication waits its own turn, and end while it publishes another room.
 */
type PublishedRooms = {
  rooms?: readonly (string | null)[];
  always?: boolean;
  waits?: (placeId: string) => boolean;
};

// The rooms a publication leaves as they are: those that wait as it reads
// the lights, since what it then reads of them is from before what they
// wait for even once that is over, and those that wait as their turn comes.
function leftWaiting(waits: PublishedRooms["waits"], rooms: Iterable<string>) {
  const asRead = new Set([...rooms].filter((room) => waits?.(room)));
  return (room: string) => asRead.has(room) || waits?.(room) === true;
}

// One publication at a time, so a button worked out before a change never
// lands after one worked out since.
let turn: Promise<unknown> = Promise.resolve();

/**
 * Publishes these rooms' buttons and rules for turning them on as they stand
 * now, those that changed only, and takes out those that are none any more.
 * Without rooms it does every room with a light and every room it published
 * a button for, and with `always` it publishes each again whether or not it
 * changed, as on start.
 */
export function publishRooms(
  ctx: AppContext,
  options: FollowOptions,
  which?: PublishedRooms,
) {
  const mine = turn.then(() => publishNow(ctx, options, which ?? {}));
  turn = mine.catch(() => undefined);
  return mine;
}

async function publishNow(
  ctx: AppContext,
  options: FollowOptions,
  which: PublishedRooms,
) {
  const { db } = ctx.storage;
  const rooms = which.rooms?.filter((room): room is string => room !== null);
  if (rooms?.length === 0) return;
  const recorded = new Map(
    (await db.select().from(roomButtons)).map((row) => [row.placeId, row]),
  );
  const isLeft = leftWaiting(which.waits, rooms ?? recorded.keys());
  const devices = await ctx.devices.list();
  // A call may have waited for a light or another publication while the
  // household switched natural light off. Publish what stands now.
  options = await followOptionsFor(ctx, options);
  const shows = options.isOn && (await homeSun(ctx, options.now())) !== null;
  const rows = shows ? await rowsOf(ctx) : new Map<string, Followed>();
  const wanted = rooms ?? [
    ...new Set([
      ...devices.flatMap((device) => (device.roomId ? [device.roomId] : [])),
      ...recorded.keys(),
    ]),
  ];
  for (const placeId of new Set(wanted)) {
    if (isLeft(placeId)) continue;
    const state = shows ? roomStateOf(placeId, devices, rows, ctx.appId) : null;
    const kept = recorded.get(placeId);
    if (!state) {
      if (!kept) continue;
      await ctx.entities.remove(roomKey(placeId));
      await ctx.entities.remove(turnOnKey(placeId));
      await db.delete(roomButtons).where(eq(roomButtons.placeId, placeId));
      continue;
    }
    const turnOn = turnOnOf(placeId, devices, rows);
    const isButtonKept =
      !which.always &&
      kept !== undefined &&
      isDeepStrictEqual(kept.state, state);
    const isTurnOnKept =
      !which.always &&
      kept !== undefined &&
      isDeepStrictEqual(kept.turnOn, turnOn);
    if (isButtonKept && isTurnOnKept) continue;
    // Recorded before they go out, so a failed publication is tried again.
    await db
      .insert(roomButtons)
      .values({ placeId, state: null, turnOn: null })
      .onConflictDoUpdate({
        target: roomButtons.placeId,
        set: {
          ...(isButtonKept ? {} : { state: null }),
          ...(isTurnOnKept ? {} : { turnOn: null }),
        },
      });
    if (!isButtonKept) await publishButton(ctx, state);
    if (!isTurnOnKept) {
      await ctx.entities.publish({
        type: turnOnType.id,
        key: turnOnKey(placeId),
        name: "Natural light",
        state: turnOn,
      });
      await db
        .update(roomButtons)
        .set({ turnOn })
        .where(eq(roomButtons.placeId, placeId));
    }
  }
}

// A room's button, out and then recorded as it went.
async function publishButton(ctx: AppContext, state: RoomState) {
  await ctx.entities.publish({
    type: roomType.id,
    key: roomKey(state.placeId),
    name: "Natural light",
    state,
  });
  await ctx.storage.db
    .update(roomButtons)
    .set({ state })
    .where(eq(roomButtons.placeId, state.placeId));
}

/**
 * Publishes again the buttons of these rooms that are out, White or not as
 * their lights stand now, and nothing else: it adds and takes out no button
 * and leaves the rules for turning on, which publishRooms does. It asks the
 * core only for the lights, so a button follows its room's lights closely
 * while each light is still being set. `waits` leaves a room as it is, as
 * for publishRooms.
 *
 * `held` gives the devices as the caller holds them, or none where it holds
 * none. They decide only whether the core is asked at all: a room's lights
 * each change several times as the room is switched, and nearly every such
 * change leaves its button as it is. Where the held devices leave every
 * button as recorded, nothing is asked and nothing published; otherwise the
 * lights are read from the core as ever, and only what it says is published.
 */
export function publishButtons(
  ctx: AppContext,
  rooms: readonly string[],
  waits?: (placeId: string) => boolean,
  held?: () => readonly DeviceInfo[] | null,
) {
  const mine = turn.then(() => publishButtonsNow(ctx, rooms, waits, held));
  turn = mine.catch(() => undefined);
  return mine;
}

async function publishButtonsNow(
  ctx: AppContext,
  rooms: readonly string[],
  waits?: (placeId: string) => boolean,
  held?: () => readonly DeviceInfo[] | null,
) {
  const { db } = ctx.storage;
  // One recorded with no state is on its way out or failed, which
  // publishRooms tries again.
  const out = (await db.select().from(roomButtons)).filter(
    (row) => rooms.includes(row.placeId) && row.state !== null,
  );
  if (out.length === 0) return;
  // Read in this publication's turn, so they are the devices as its turn
  // finds them.
  const heldNow = held?.();
  if (heldNow) {
    const rows = await rowsOf(ctx);
    const isAsRecorded = out.every((kept) => {
      const state = roomStateOf(kept.placeId, heldNow, rows, ctx.appId);
      return !state || isDeepStrictEqual(kept.state, state);
    });
    if (isAsRecorded) return;
  }
  const isLeft = leftWaiting(
    waits,
    out.map((row) => row.placeId),
  );
  const devices = await ctx.devices.list();
  const rows = await rowsOf(ctx);
  for (const kept of out) {
    if (isLeft(kept.placeId)) continue;
    const state = roomStateOf(kept.placeId, devices, rows, ctx.appId);
    if (!state || isDeepStrictEqual(kept.state, state)) continue;
    // Recorded before it goes out, so a failed publication is tried again.
    await db
      .update(roomButtons)
      .set({ state: null })
      .where(eq(roomButtons.placeId, kept.placeId));
    await publishButton(ctx, state);
  }
}

/** A light the press could not reach, which the shell fails on its tile. */
export type Failed = { device: string; capability: string };

// A press reaches every light of the room at once, as the room's button for
// all its lights does, so the room changes in one step rather than light by
// light. Each light still takes its own turn (runForLight).
async function eachLight(
  ctx: AppContext,
  runForLight: RunForLight,
  lights: readonly RoomLight[],
  work: (light: RoomLight) => Promise<void>,
): Promise<Failed[]> {
  const failed = await Promise.all(
    lights.map(async (light): Promise<Failed | null> => {
      const each = { device: light.device.id, capability: light.capability.id };
      try {
        await runForLight(each.device, each.capability, () => work(light));
        return null;
      } catch (error) {
        ctx.log(
          `could not set ${light.device.name} (${isActionError(error) ? error.code : error instanceof Error ? error.message : String(error)})`,
        );
        return each;
      }
    }),
  );
  return failed.filter((each) => each !== null);
}

// Bringing a room to natural light needs it to be available, even if the
// room's tile is still on screen after its settings changed.
async function requireRoomSun(
  ctx: AppContext,
  options: FollowOptions,
  now: Date,
) {
  if (!options.isOn) {
    throw new ActionError("conflict", "Natural light is switched off");
  }
  const sun = await homeSun(ctx, now);
  if (!sun) {
    throw new ActionError(
      "conflict",
      "Natural light waits for the home's location",
    );
  }
  return sun;
}

/**
 * Brings the room to natural light: every light that follows on at the
 * curve, its pause or dim ended, and every other light that is on off.
 */
export async function bringRoom(
  ctx: AppContext,
  options: FollowOptions,
  runForLight: RunForLight,
  placeId: string,
): Promise<Failed[]> {
  const now = options.now();
  const sun = await requireRoomSun(ctx, options, now);
  const lights = lightsIn(await ctx.devices.list(), placeId);
  const rows = await rowsOf(ctx);
  if (
    !lights.some(
      (light) =>
        takesColorTemperature(light.capability) && rows.has(keyOf(light)),
    )
  ) {
    throw new ActionError("conflict", "No reachable light follows in the room");
  }
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
      .set({
        since: now,
        pausedAt: null,
        dimmedAt: null,
        applied: look,
        appliedAt: now,
      })
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
