import { ActionError, defineAction, defineApp } from "@meetsanctum/app-sdk";
import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { notes } from "./schema.js";

// A small app for the app host's tests, loaded from its package like a
// catalog app: a household board, and personal notes that only their person
// sees, which the app itself keeps to them.

const note = z.object({
  id: z.number(),
  text: z.string(),
  personal: z.boolean(),
});

const add = defineAction({
  id: "notes.add",
  title: "Add a note",
  tier: "write",
  // A personal note needs a person, which a shared client has not.
  input: z.object({
    text: z.string().min(1),
    personal: z.boolean().default(false),
  }),
  output: z.object({ id: z.number() }),
  async run(ctx, input) {
    if (input.personal && ctx.actor.kind !== "user") {
      throw new ActionError("forbidden", "Personal notes need a person");
    }
    const row = await ctx.storage.db
      .insert(notes)
      .values({
        text: input.text,
        personId: input.personal ? ctx.actor.id : null,
      })
      .returning({ id: notes.id })
      .get();
    return { id: row.id };
  },
});

const list = defineAction({
  id: "notes.list",
  title: "Notes",
  tier: "read",
  input: z.object({}),
  output: z.array(note),
  async run(ctx) {
    const mine =
      ctx.actor.kind === "user" ? eq(notes.personId, ctx.actor.id) : undefined;
    const rows = await ctx.storage.db
      .select()
      .from(notes)
      .where(mine ? or(isNull(notes.personId), mine) : isNull(notes.personId))
      .orderBy(notes.id)
      .all();
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      personal: row.personId !== null,
    }));
  },
});

// Another person's note stays as it is.
const rename = defineAction({
  id: "notes.rename",
  title: "Rename a note",
  tier: "write",
  input: z.object({ id: z.number(), text: z.string().min(1) }),
  output: z.object({ renamed: z.boolean() }),
  async run(ctx, input) {
    const mine =
      ctx.actor.kind === "user" ? eq(notes.personId, ctx.actor.id) : undefined;
    const rows = await ctx.storage.db
      .update(notes)
      .set({ text: input.text })
      .where(
        and(
          eq(notes.id, input.id),
          mine ? or(isNull(notes.personId), mine) : isNull(notes.personId),
        ),
      )
      .returning({ id: notes.id })
      .all();
    return { renamed: rows.length > 0 };
  },
});

const clear = defineAction({
  id: "notes.clear",
  title: "Clear the board",
  tier: "destructive",
  input: z.object({}),
  output: z.object({ cleared: z.number() }),
  async run(ctx) {
    const rows = await ctx.storage.db
      .delete(notes)
      .where(isNull(notes.personId))
      .returning({ id: notes.id })
      .all();
    return { cleared: rows.length };
  },
});

export default defineApp({
  id: "test.notes",
  name: "Notes",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [],
  migrations: "migrations",
  actions: [add, list, rename, clear],
  events: [],
});
