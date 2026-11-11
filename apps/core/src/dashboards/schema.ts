import { dashboardBackgrounds, dashboardKinds } from "@meetsanctum/app-sdk";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { devices } from "../devices/schema.js";

// Dashboards: the home's first screens, which belong to the household, not
// to a person or a client. A home always has Home, and only one
// (dashboards.ts).
export const dashboards = sqliteTable("dashboards", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // A named preset the shell draws.
  background: text("background", { enum: dashboardBackgrounds }).notNull(),
  // Home, or one of the household's own. Dashboards from before Home was a
  // kind are the household's own until the first becomes Home on start.
  kind: text("kind", { enum: dashboardKinds }).notNull().default("custom"),
  // Where it comes among the others, lowest first, after Home. Removing one
  // leaves a gap, which changes nothing.
  position: integer("position").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// The devices on Home, each once, in the household's order: Home shows each
// room's by position, lowest first. A device removed from the home leaves
// it too.
export const homeDevices = sqliteTable("home_devices", {
  deviceId: text("device_id")
    .primaryKey()
    .references(() => devices.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
});
