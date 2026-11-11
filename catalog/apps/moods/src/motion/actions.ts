import {
  ActionError,
  defineAction,
  type AppContext,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { assertRoom, roomId } from "../moods/actions.js";
import { changeAndSync, readMotion, roomMotion } from "./motion.js";
import {
  darkerThanChoices,
  motionSensorsIn,
  stillRoom,
  turnOffAfterChoices,
  type MotionChange,
} from "./room-motion.js";

// The Motion section's actions on Moods' page for a room: what motion does
// to each room's lights, and changing it. They are the household's, so
// anyone may read and change them, on a shared client too. Each change puts
// or removes the workflows Moods keeps for the room (motion.ts).

export const roomMotionSchema = z.object({
  roomId: z.string(),
  turnOn: z.boolean(),
  /** The level in lux the room must be darker than; null for any. */
  darkerThan: z.number().nullable(),
  /** The minutes with no motion before the lights turn off; null leaves them on. */
  turnOffAfter: z.number().int().nullable(),
});

export const listMotion = defineAction({
  id: "moods.motion",
  title: "What motion does to rooms' lights",
  tier: "read",
  input: z.object({ roomId: roomId.optional() }),
  output: z.array(roomMotionSchema),
  async run(ctx, input) {
    const rooms = input.roomId
      ? [input.roomId]
      : (await ctx.places.list()).rooms.map((room) => room.id);
    const chosen = new Map(
      (await readMotion(ctx.storage.db)).map((each) => [each.roomId, each]),
    );
    return rooms.map((room) => chosen.get(room) ?? stillRoom(room));
  },
});

// Whether a change starts motion doing something it did not.
function starts(
  before: Awaited<ReturnType<typeof roomMotion>>,
  change: MotionChange,
) {
  return (
    (change.turnOn === true && !before.turnOn) ||
    (change.turnOffAfter != null && before.turnOffAfter === null)
  );
}

async function hasMotionSensor(ctx: AppContext, room: string) {
  return motionSensorsIn(await ctx.devices.list(), room).length > 0;
}

export const setMotion = defineAction({
  id: "moods.setMotion",
  title: "Choose what motion does to a room's lights",
  tier: "write",
  input: z
    .object({
      roomId,
      turnOn: z.boolean().optional(),
      // Null for any light level.
      darkerThan: z.literal(darkerThanChoices).nullable().optional(),
      // Null leaves the lights on.
      turnOffAfter: z.literal(turnOffAfterChoices).nullable().optional(),
    })
    .refine(
      ({ turnOn, darkerThan, turnOffAfter }) =>
        turnOn !== undefined ||
        darkerThan !== undefined ||
        turnOffAfter !== undefined,
      "a change asks for something",
    ),
  output: roomMotionSchema,
  async run(ctx, input) {
    const { roomId: room, ...change } = input;
    await assertRoom(ctx, room);
    const before = await roomMotion(ctx.storage.db, room);
    // Motion can do nothing in a room no motion sensor sees, so it is not
    // started there; stopping it always is.
    if (starts(before, change) && !(await hasMotionSensor(ctx, room))) {
      throw new ActionError("conflict", "The room has no motion sensor");
    }
    await changeAndSync(ctx, room, change);
    return roomMotion(ctx.storage.db, room);
  },
});

export const motionActions = [listMotion, setMotion];
