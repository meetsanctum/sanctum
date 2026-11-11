import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The notes fixture's own table, in its own database file.
export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
  // Whose personal note it is; household notes have none.
  personId: text("person_id"),
});
