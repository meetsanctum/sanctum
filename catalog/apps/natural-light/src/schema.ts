import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Natural light's own database: the lights that follow the curve, the
// lights the household left out, and each room's button as last published. Every light that takes a colour
// temperature follows unless it is left out (choices.ts). A light has a row
// in followed_lights while it follows, and whether it is paused is mostly
// read from who last set it (lights.ts).

/** What natural light sets a light to: a colour temperature in mireds, and a brightness where the light dims. */
export type Look = { colorTemperature: number; brightness?: number };

export const followedLights = sqliteTable(
  "followed_lights",
  {
    deviceId: text("device_id").notNull(),
    capabilityId: text("capability_id").notNull(),
    // Since it began following, or was last resumed: what others set before
    // that does not pause it.
    since: integer("since", { mode: "timestamp_ms" }).notNull(),
    // Paused on purpose (naturalLight.pause), or by a chosen colour, until
    // it is switched off or on.
    pausedAt: integer("paused_at", { mode: "timestamp_ms" }),
    // Since someone set its brightness alone: natural light keeps its colour
    // on the curve and leaves its brightness to them, until it is switched
    // off or on.
    dimmedAt: integer("dimmed_at", { mode: "timestamp_ms" }),
    // What natural light last set it to, and when.
    applied: text("applied", { mode: "json" }).$type<Look>(),
    appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.capabilityId] })],
);

export const leftOutLights = sqliteTable(
  "left_out_lights",
  {
    deviceId: text("device_id").notNull(),
    capabilityId: text("capability_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.capabilityId] })],
);

// Each room's Natural light button, and its rule for turning the room on, as
// they were last published, so each is published again only when it
// changes, and taken out of the home once its room has no light that
// follows, even one removed while natural light was stopped. A row is
// written before its entities are published, with neither until the core
// has taken them.
export const roomButtons = sqliteTable("room_buttons", {
  placeId: text("place_id").primaryKey(),
  state: text("state", { mode: "json" }).$type<unknown>(),
  turnOn: text("turn_on", { mode: "json" }).$type<unknown>(),
});
