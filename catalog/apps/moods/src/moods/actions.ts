import {
  ActionError,
  defineAction,
  entityOf,
  type AppContext,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { failedLight, sendCommands } from "../lights.js";
import { refreshRoom } from "../refresh.js";
import { lightsInRoom, type Light } from "../targets.js";
import { moodType } from "./entities.js";
import { moodIcons } from "./icons.js";
import {
  lightKey,
  moodCommands,
  type MoodLight,
  type MoodLightState,
  type PreviewLight,
  type PreviewLightState,
} from "./light-states.js";
import { lightsOf } from "./smart.js";
import {
  changeMood,
  insertMood,
  readMood,
  readMoods,
  removeMood,
  reorderMoods,
  type Mood,
} from "./store.js";

// Moods (v1's custom moods, Pragmata v1-final): what a room's lights are
// set to, captured from them, run in one go and shown as active while the
// lights still show it. Smart moods, from Moods' catalog, have their own
// actions in smart-actions.ts and run and list with these. Moods are the
// household's: anyone, a shared client included, may run, make, change,
// order and delete them. Deleting one is an everyday write, as deleting a
// dashboard is, and its page asks first. Each change publishes its room's
// moods again (entities.ts), and what turning the room on brings
// (turn-on.ts); deleting one takes it off the room's schedule too.

export const roomId = z.string().min(1);
const name = z.string().trim().min(1).max(120);
const icon = z.enum(moodIcons);

// A light on or off, with the level and colour it has when on.
const withLook = <On extends boolean>(on: On) =>
  z
    .strictObject({
      on: z.literal(on),
      brightness: z.number().int().min(1).max(100).optional(),
      colorTemperature: z.number().int().min(50).max(1000).optional(),
      hue: z.number().min(0).max(360).optional(),
      saturation: z.number().min(0).max(100).optional(),
    })
    .refine(
      (state) => (state.hue === undefined) === (state.saturation === undefined),
      "hue and saturation go together",
    )
    .refine(
      (state) =>
        state.hue === undefined || state.colorTemperature === undefined,
      "a colour or a colour temperature, not both",
    );

const moodLightState = z.discriminatedUnion("on", [
  z.strictObject({ on: z.literal(false) }),
  withLook(true),
]) satisfies z.ZodType<MoodLightState>;

const previewLightState = z.discriminatedUnion("on", [
  withLook(false),
  withLook(true),
]) satisfies z.ZodType<PreviewLightState>;

/** A light by its device and capability. */
export const lightRef = z.strictObject({
  device: z.string().min(1),
  capability: z.string().min(1),
});

const moodLight = lightRef.extend({
  state: moodLightState,
}) satisfies z.ZodType<MoodLight>;

const listOf = <Light extends z.ZodType<z.infer<typeof lightRef>>>(
  light: Light,
) =>
  z
    .array(light)
    .min(1)
    .max(200)
    .refine(
      (list) =>
        new Set(list.map((each) => lightKey(each.device, each.capability)))
          .size === list.length,
      "each light once",
    );

const lights = listOf(moodLight);

export const mood = z.object({
  id: z.string(),
  roomId: z.string(),
  name: z.string(),
  icon,
  // A custom mood's lights; none for a smart one.
  lights: z.array(moodLight),
  // A smart mood's definition and settings, null for a custom one.
  smart: z
    .object({
      definition: z.string(),
      brightness: z.number().int(),
      off: z.array(lightRef),
    })
    .nullable(),
}) satisfies z.ZodType<Mood>;

export const ran = z.object({
  switched: z.number().int(),
  // The lights that could not be set, so a page can show which.
  failed: z.array(failedLight),
});

export async function assertRoom(ctx: AppContext, id: string) {
  const places = await ctx.places.list();
  if (!places.rooms.some((room) => room.id === id)) {
    throw new ActionError("not_found");
  }
}

// Sets a room's lights as a mood does, by the target-portion rule.
async function runIn(
  ctx: AppContext,
  room: string,
  moodLights: (inRoom: readonly Light[]) => readonly PreviewLight[],
) {
  const inRoom = lightsInRoom(await ctx.devices.list(), room);
  const { sent, failed } = await sendCommands(
    ctx,
    moodCommands(moodLights(inRoom), inRoom),
  );
  return { switched: sent, failed };
}

export const listMoods = defineAction({
  id: "moods.moods",
  title: "Moods",
  tier: "read",
  input: z.object({ roomId: roomId.optional() }),
  output: z.array(mood),
  async run(ctx, input) {
    return readMoods(ctx.storage.db, input.roomId);
  },
});

export const createMood = defineAction({
  id: "moods.createMood",
  title: "Create a mood",
  tier: "write",
  input: z.object({ roomId, name, icon: icon.default("sparkles"), lights }),
  output: mood,
  async run(ctx, input) {
    await assertRoom(ctx, input.roomId);
    const created = await insertMood(ctx.storage.db, input);
    await refreshRoom(ctx, created.roomId);
    return created;
  },
});

export const updateMood = defineAction({
  id: "moods.updateMood",
  title: "Change a mood",
  tier: "write",
  input: z
    .object({
      id: z.string().min(1),
      name: name.optional(),
      icon: icon.optional(),
      lights: lights.optional(),
    })
    .refine(
      (patch) =>
        patch.name !== undefined ||
        patch.icon !== undefined ||
        patch.lights !== undefined,
      "a change asks for something",
    ),
  output: mood,
  async run(ctx, { id, ...patch }) {
    const changed = await changeMood(ctx.storage.db, id, patch);
    await refreshRoom(ctx, changed.roomId);
    return changed;
  },
});

export const deleteMood = defineAction({
  id: "moods.deleteMood",
  title: "Delete a mood",
  tier: "write",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ id: z.string() }),
  async run(ctx, input) {
    const room = await removeMood(ctx.storage.db, input.id);
    if (room === null) {
      throw new ActionError("not_found");
    }
    await refreshRoom(ctx, room);
    return { id: input.id };
  },
});

export const orderMoods = defineAction({
  id: "moods.orderMoods",
  title: "Order a room's moods",
  tier: "write",
  input: z.object({
    roomId,
    moodIds: z
      .array(z.string().min(1))
      .refine((ids) => new Set(ids).size === ids.length, "each mood once"),
  }),
  // The room's moods, in their new order.
  output: z.object({ moodIds: z.array(z.string()) }),
  async run(ctx, input) {
    await assertRoom(ctx, input.roomId);
    const moodIds = await reorderMoods(
      ctx.storage.db,
      input.roomId,
      input.moodIds,
    );
    await refreshRoom(ctx, input.roomId);
    return { moodIds };
  },
});

export const runMood = defineAction({
  id: "moods.runMood",
  title: "Run a mood",
  tier: "write",
  // A mood by its entity's key, which is its id, so Automations picks one
  // from the moods the home has.
  input: z.object({ id: entityOf(moodType.id) }),
  output: ran,
  words: { sentence: "Run {id}", preview: { id: "Aurora" } },
  async run(ctx, input) {
    const found = await readMood(ctx.storage.db, input.id);
    if (!found) throw new ActionError("not_found");
    return runIn(ctx, found.roomId, (inRoom) => lightsOf(found, inRoom));
  },
});

// v1's draft run: the mood editor shows a mood on the lights before it is
// saved, and puts back what the lights were on cancel, through the same
// rule as running it. A smart mood's editor works out its lights as
// lightsOf does and previews them here too. Putting a light back off, it
// says the level and colour the light comes back at.
export const previewMood = defineAction({
  id: "moods.previewMood",
  title: "Preview a mood",
  tier: "write",
  input: z.object({
    roomId,
    lights: listOf(lightRef.extend({ state: previewLightState })),
  }),
  output: ran,
  async run(ctx, input) {
    await assertRoom(ctx, input.roomId);
    return runIn(ctx, input.roomId, () => input.lights);
  },
});

export const moodActions = [
  listMoods,
  createMood,
  updateMood,
  deleteMood,
  orderMoods,
  runMood,
  previewMood,
];
