import type { TemperatureUnit } from "@meetsanctum/app-sdk";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Places: the home and its floors, rooms and zones. Apps refer to them by id.

// One row: the home itself, and where it is for Weather.
export const home = sqliteTable("home", {
  // Always 1.
  id: integer("id").primaryKey(),
  // The household's data in this database, as opposed to the host it runs
  // on. Set on the first start of the database, or of a core with this
  // column, and never replaced; in every backup, so it comes back with a
  // restore, onto the same host or another.
  homeId: text("home_id"),
  name: text("name").notNull(),
  // Where the home is, which the household sets: both coordinates or neither,
  // and only with a time zone. Until then Weather knows no sun times and
  // fetches no forecast.
  latitude: real("latitude"),
  longitude: real("longitude"),
  // Metres above sea level, which sun times count; only with the
  // coordinates, and optional with them.
  elevation: real("elevation"),
  // An IANA time zone, such as Europe/Zurich: the home's days run in it.
  // It may be set without coordinates; while it is not, the host's applies.
  timeZone: text("time_zone"),
  // How the home shows temperatures; readings stay in Celsius.
  temperatureUnit: text("temperature_unit")
    .$type<TemperatureUnit>()
    .notNull()
    .default("celsius"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const floors = sqliteTable("floors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // 0 for the ground floor, negative below it.
  level: integer("level").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const rooms = sqliteTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // Removing a floor keeps its rooms, on no floor.
    floorId: text("floor_id").references(() => floors.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("rooms_floor_id").on(table.floorId)],
);

// A group of rooms, such as "Upstairs" or "Kids".
export const zones = sqliteTable("zones", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const zoneRooms = sqliteTable(
  "zone_rooms",
  {
    zoneId: text("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.zoneId, table.roomId] }),
    index("zone_rooms_room_id").on(table.roomId),
  ],
);
