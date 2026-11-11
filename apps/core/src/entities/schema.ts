import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Entities: what apps bring to the home, each published by its app under its
// own key, of a type the app declares. The core keeps the latest state of
// each, so reading one never runs the app, and lists them as each app's
// catalog.

export const entities = sqliteTable(
  "entities",
  {
    appId: text("app_id").notNull(),
    // The app's own key for it.
    key: text("key").notNull(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    state: text("state", { mode: "json" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.key] }),
    index("entities_type").on(table.type),
  ],
);
