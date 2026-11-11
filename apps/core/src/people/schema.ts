import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// People: the household's members. Logins are Auth's, in its own tables.

export const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // A picture from the avatar set, or none for initials.
  avatar: text("avatar"),
  // The identity colour, as #rrggbb, that tints the person's things.
  colour: text("colour").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
