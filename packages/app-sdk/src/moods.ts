import { z } from "zod";

import { defineEntityType } from "./entities.js";
import { tileIcons } from "./room-sections.js";

// A mood: a look a room's devices take together, such as its lights, which an
// app keeps and runs.
// Its entity is in the tile shape a room section draws, and its `input` is
// what the app's own action that runs moods (that action's `runs`) takes, so
// whoever reads moods by this type runs one without knowing which app keeps
// it or how it names its action.

export const moodSchema = z.object({
  /** The mood's room. */
  placeId: z.string(),
  icon: z.enum(tileIcons),
  name: z.string(),
  /** Its place among the room's moods, from 0. */
  order: z.number().int().min(0),
  /** Whether the room shows it now. */
  active: z.boolean(),
  /** What the app's action that runs moods takes to run this one. */
  input: z.record(z.string(), z.unknown()),
});
export type MoodState = z.infer<typeof moodSchema>;

/** What running a mood answers: the devices it set, and those it couldn't. */
export const moodRunSchema = z.object({
  /** How many devices were sent their part of the mood. */
  switched: z.number().int().min(0),
  /** The devices that could not be set, so a page can show which. */
  failed: z.array(
    z.object({ device: z.string().min(1), capability: z.string().min(1) }),
  ),
});
export type MoodRun = z.infer<typeof moodRunSchema>;

export const moodType = defineEntityType({
  id: "mood",
  title: "Mood",
  state: moodSchema,
  standard: true,
  run: {
    output: moodRunSchema,
    description:
      "A mood sets its room's lights and can turn others there off; it answers how many it set and those it couldn't reach.",
  },
  assistant: {
    starts: "on",
    description:
      "The rooms' moods, with each mood's room ID, name, icon, display order and whether it is active. Run one with the run tool, by its app and key.",
  },
});
