import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// What AI agents can use, as the household has it: one answer for every AI
// agent. Each row is recorded when the core first sees what it answers, and
// keeps its answer from then on. No foreign key: an app's rows stay while it
// is removed, for when it comes back.

/** Each app's offer: one of its actions, or an entity type it provides. */
export const agentItems = sqliteTable(
  "agent_items",
  {
    appId: text("app_id").notNull(),
    // The kind and id together, since an action and an entity can share an id.
    itemId: text("item_id").notNull(),
    on: integer("on", { mode: "boolean" }).notNull(),
    // The tier it had when last answered: one that rises goes back off.
    tier: text("tier", { enum: ["read", "write"] }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.itemId] })],
);

/** The core's areas, by the permission each is, such as `people.read`. */
export const agentAreas = sqliteTable("agent_areas", {
  area: text("area").primaryKey(),
  on: integer("on", { mode: "boolean" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
