import { ActionError, defineAction } from "@meetsanctum/app-sdk";
import { z } from "zod";

import { assertRoom, lightRef, mood, roomId } from "./actions.js";
import { refreshRoom } from "../refresh.js";
import { lightKey } from "./light-states.js";
import { smartCatalog, smartDefinition } from "./smart.js";
import { changeSmartMood, insertMood } from "./store.js";

// Smart moods (v1's smart mood assignments, Pragmata v1-final): a
// definition from Moods' catalog assigned to a room, once per room, with a
// brightness and the lights it leaves off. They run, list, order and
// delete with the custom moods (actions.ts), and their editor previews
// them through moods.previewMood. Who may do what is as for those: they
// are the household's.

const brightness = z.number().int().min(1).max(100);
const off = z
  .array(lightRef)
  .max(200)
  .refine(
    (list) =>
      new Set(list.map((each) => lightKey(each.device, each.capability)))
        .size === list.length,
    "each light once",
  );

const colour = z.object({
  hue: z.number(),
  saturation: z.number(),
});

export const listSmartMoods = defineAction({
  id: "moods.smartMoods",
  title: "Smart moods",
  tier: "read",
  input: z.object({}),
  output: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      moods: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          icon: z.string(),
          brightness: z.number().int(),
          colours: z.array(colour),
        }),
      ),
    }),
  ),
  run: async () =>
    smartCatalog.map((group) => ({
      ...group,
      moods: group.moods.map((each) => ({
        ...each,
        colours: [...each.colours],
      })),
    })),
});

export const assignSmartMood = defineAction({
  id: "moods.assignSmartMood",
  title: "Add a smart mood",
  tier: "write",
  input: z.object({
    roomId,
    definitionId: z.string().min(1),
    // The definition's own when left out.
    brightness: brightness.optional(),
    off: off.default([]),
  }),
  output: mood,
  async run(ctx, input) {
    const definition = smartDefinition(input.definitionId);
    if (!definition) throw new ActionError("not_found");
    await assertRoom(ctx, input.roomId);
    const assigned = await insertMood(ctx.storage.db, {
      roomId: input.roomId,
      name: definition.name,
      icon: definition.icon,
      lights: [],
      smart: {
        definition: definition.id,
        brightness: input.brightness ?? definition.brightness,
        off: input.off,
      },
    });
    await refreshRoom(ctx, assigned.roomId);
    return assigned;
  },
});

export const updateSmartMood = defineAction({
  id: "moods.updateSmartMood",
  title: "Change a smart mood",
  tier: "write",
  input: z
    .object({
      id: z.string().min(1),
      brightness: brightness.optional(),
      off: off.optional(),
    })
    .refine(
      (patch) => patch.brightness !== undefined || patch.off !== undefined,
      "a change asks for something",
    ),
  output: mood,
  async run(ctx, { id, ...patch }) {
    const changed = await changeSmartMood(ctx.storage.db, id, patch);
    await refreshRoom(ctx, changed.roomId);
    return changed;
  },
});

export const smartMoodActions = [
  listSmartMoods,
  assignSmartMood,
  updateSmartMood,
];
