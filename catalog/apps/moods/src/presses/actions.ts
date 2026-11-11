import {
  ActionError,
  defineAction,
  type AppContext,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { readMood } from "../moods/store.js";
import {
  buttonOf,
  chooseAndSync,
  defaultOf,
  isDimmer,
  lightKeys,
  pressChoice,
  readPresses,
  whileHeld,
  type PressChoice,
} from "./presses.js";

// The Presses page's actions: what each press of a remote does, by choice or
// by default, and choosing it.
// Presses are household things, so anyone may choose them, shared clients
// too.

const device = z.string().min(1).max(64);

const listing = z.object({
  presses: z.array(
    z.object({
      action: z.string(),
      choice: pressChoice.nullable(),
      /** What it does while it is not chosen. */
      default: pressChoice.nullable(),
      /** Whether it lasts until its release, so it can do something while held. */
      hold: z.boolean(),
    }),
  ),
  /** The room the presses not chosen are for, and whether as its dimmer. */
  defaults: z.object({ roomId: z.string(), dimmer: z.boolean() }).nullable(),
});

async function remoteOf(ctx: AppContext, deviceId: string) {
  const found = await ctx.devices.state(deviceId);
  const button = buttonOf(found);
  if (!button) {
    throw new ActionError("not_found");
  }
  return { device: found, button };
}

async function presses(ctx: AppContext, deviceId: string) {
  const { device: found, button } = await remoteOf(ctx, deviceId);
  const chosen = await readPresses(ctx.storage.db, deviceId);
  return {
    presses: button.features.actions.map((action) => ({
      action,
      choice: chosen.get(action) ?? null,
      default: defaultOf(button, action, found.roomId),
      hold: button.features.holds.includes(action),
    })),
    defaults: found.roomId
      ? { roomId: found.roomId, dimmer: isDimmer(button) }
      : null,
  };
}

// Whether the home has what a choice names, as it is chosen.
async function exists(ctx: AppContext, choice: PressChoice) {
  if (choice.kind === "mood") {
    return (await readMood(ctx.storage.db, choice.moodId)) !== null;
  }
  if (choice.kind === "lights" && choice.place.kind === "lights") {
    const lights = lightKeys(await ctx.devices.list());
    return choice.place.lights.every((light) =>
      lights.has(`${light.device}/${light.capability}`),
    );
  }
  if (
    choice.kind === "lights" &&
    (choice.place.kind === "room" || choice.place.kind === "zone")
  ) {
    const places = await ctx.places.list();
    const { kind, id } = choice.place;
    return (kind === "room" ? places.rooms : places.zones).some(
      (each) => each.id === id,
    );
  }
  return true;
}

export const listPresses = defineAction({
  id: "moods.presses",
  title: "What a remote's presses do",
  tier: "read",
  input: z.object({ device }),
  output: listing,
  run: (ctx, input) => presses(ctx, input.device),
});

export const choosePress = defineAction({
  id: "moods.choosePress",
  title: "Choose what a press does",
  tier: "write",
  input: z.object({
    device,
    action: z.string().min(1).max(64),
    // None takes the choice back.
    choice: pressChoice.nullable(),
  }),
  output: listing,
  async run(ctx, input) {
    const { button } = await remoteOf(ctx, input.device);
    if (!button.features.actions.includes(input.action)) {
      throw new ActionError("not_found");
    }
    if (input.choice && !(await exists(ctx, input.choice))) {
      throw new ActionError("not_found");
    }
    // Only a hold lasts long enough to do something while held.
    if (
      input.choice?.kind === "lights" &&
      whileHeld.has(input.choice.to) &&
      !button.features.holds.includes(input.action)
    ) {
      throw new ActionError("conflict", `${input.action} is not a hold`);
    }
    await chooseAndSync(ctx, input.device, input.action, input.choice);
    return presses(ctx, input.device);
  },
});

export const pressActions = [listPresses, choosePress];
