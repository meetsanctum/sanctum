import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The household's pinned apps, each once, at the top of the sidebar by
// position, lowest first. No foreign key: Sanctum's own apps, such as
// `sanctum.settings`, are pinnable and are not installed apps.
export const pinnedApps = sqliteTable("pinned_apps", {
  appId: text("app_id").primaryKey(),
  position: integer("position").notNull(),
});
