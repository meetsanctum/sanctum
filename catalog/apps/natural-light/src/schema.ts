import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Natural light's own database: the lights that follow the curve, ported
// from v1's natural_lighting_targets. v1 kept a row for every light it had
// seen, with a flag and a pause state; here a light has a row while it
// follows, and whether it is paused is mostly read from who last set it
// (lights.ts).

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
    // Paused on purpose (naturalLight.pause) until it is switched off or
    // on.
    pausedAt: integer("paused_at", { mode: "timestamp_ms" }),
    // What natural light last set it to, and when.
    applied: text("applied", { mode: "json" }).$type<Look>(),
    appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.capabilityId] })],
);
