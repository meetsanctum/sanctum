import type {
  Availability,
  CapabilityKind,
  HistoryPeriod,
} from "@meetsanctum/app-sdk";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { devices } from "../devices/schema.js";

// History: what each device's capabilities reported over time, and roll-ups
// of it every 5 minutes and every hour, ported from v1's recorder. Removing
// a device takes its history with it.

// Each capability recorded, by a small id so the many rows below stay small.
// A capability whose kind changed starts a series afresh.
export const historySeries = sqliteTable(
  "history_series",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    capabilityId: text("capability_id").notNull(),
    kind: text("kind").$type<CapabilityKind>().notNull(),
  },
  (table) => [
    uniqueIndex("history_series_capability").on(
      table.deviceId,
      table.capabilityId,
    ),
  ],
);

// Each change of what a capability's device reported, or of whether it
// answered, from `at` until the next.
export const historyStates = sqliteTable(
  "history_states",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seriesId: integer("series_id")
      .notNull()
      .references(() => historySeries.id, { onDelete: "cascade" }),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    availability: text("availability").$type<Availability>().notNull(),
    // Its kind's state as the device reported it; none while nothing is
    // known.
    state: text("state", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("history_states_series_at").on(table.seriesId, table.at),
    index("history_states_at").on(table.at),
  ],
);

// One value of a series over a 5 minutes or an hour, weighed by the time it
// was known (statistics.ts).
export const historyStatistics = sqliteTable(
  "history_statistics",
  {
    seriesId: integer("series_id")
      .notNull()
      .references(() => historySeries.id, { onDelete: "cascade" }),
    period: text("period").$type<HistoryPeriod>().notNull(),
    start: integer("start", { mode: "timestamp_ms" }).notNull(),
    // Such as on or brightness (historyFields).
    field: text("field").notNull(),
    mean: real("mean").notNull(),
    min: real("min").notNull(),
    max: real("max").notNull(),
    seconds: integer("seconds").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.seriesId, table.period, table.start, table.field],
    }),
    index("history_statistics_period_start").on(table.period, table.start),
  ],
);

// Where each period's roll-ups have got to: every period that ended before
// `through` is done.
export const historyCompiled = sqliteTable("history_compiled", {
  period: text("period").$type<HistoryPeriod>().primaryKey(),
  through: integer("through", { mode: "timestamp_ms" }).notNull(),
});

// What the household chose for a device; one with no row is kept.
export const historyDevices = sqliteTable("history_devices", {
  deviceId: text("device_id")
    .primaryKey()
    .references(() => devices.id, { onDelete: "cascade" }),
  kept: integer("kept", { mode: "boolean" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
