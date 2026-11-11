import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type { TurnOn } from "@meetsanctum/app-sdk";

import type { PressChoice } from "../presses/presses.js";
import type { TurnOnBehaviour } from "../schedules/store.js";
import type { MoodState } from "./entities.js";
import type { MoodLightState } from "./light-states.js";

// Moods' own tables, in its own database file: the moods and what each
// custom one sets its lights to; a smart one keeps its definition and
// settings instead; what it last published for each mood; what each press of
// a remote does; and each room's schedule, how its lights turn on, the
// snapshot of them as they were when it last went dark, the lights.turnOn it
// last published, and what motion does to its lights. Rooms and devices are
// the core's, named here by id. Generate the migrations with
// `pnpm --filter @meetsanctum/moods db:generate --name <change>`.

export const moods = sqliteTable(
  "moods",
  {
    id: text("id").primaryKey(),
    // Every mood belongs to one room, as v1's did once zones were dropped.
    roomId: text("room_id").notNull(),
    name: text("name").notNull(),
    icon: text("icon").notNull(),
    // Its place among the room's moods.
    position: integer("position").notNull(),
    // A smart mood's definition from the catalog, its brightness and the
    // lights it leaves off; null for a custom mood.
    definitionId: text("definition_id"),
    brightness: integer("brightness"),
    offLights: text("off_lights", { mode: "json" }).$type<
      { device: string; capability: string }[]
    >(),
  },
  (table) => [
    index("moods_room").on(table.roomId, table.position),
    // A definition once per room, as in v1.
    uniqueIndex("moods_room_definition").on(table.roomId, table.definitionId),
  ],
);

export const moodLights = sqliteTable(
  "mood_lights",
  {
    moodId: text("mood_id")
      .notNull()
      .references(() => moods.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    capabilityId: text("capability_id").notNull(),
    state: text("state", { mode: "json" }).$type<MoodLightState>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.moodId, table.deviceId, table.capabilityId],
    }),
  ],
);

// The state Moods last published for each mood's entity (entities.ts), so
// it publishes only what changed and, after a restart, knows which
// entities to take out. A row outlives its mood until its entity is out
// of the home, so it names the mood by id alone. A null state marks a
// publication that has not been confirmed and must be retried.
export const moodEntities = sqliteTable(
  "mood_entities",
  {
    moodId: text("mood_id").primaryKey(),
    roomId: text("room_id").notNull(),
    state: text("state", { mode: "json" }).$type<MoodState>(),
  },
  (table) => [index("mood_entities_room").on(table.roomId)],
);

// What the household chose for each press of a remote (presses.ts), from
// which Moods keeps a workflow. A press with no row keeps its default,
// such as switching its room's lights on or off; "nothing" is a choice
// too, so it ends that.
export const presses = sqliteTable(
  "presses",
  {
    deviceId: text("device_id").notNull(),
    action: text("action").notNull(),
    choice: text("choice", { mode: "json" }).$type<PressChoice>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.action] })],
);

// A room's schedule (v1's room schedules): its moods, each from a start to
// an end in minutes from midnight, every day. An end not after its start
// runs past midnight; an end of 1440 is midnight. A mood's times go with
// it.
export const scheduledMoods = sqliteTable(
  "scheduled_moods",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    moodId: text("mood_id")
      .notNull()
      .references(() => moods.id, { onDelete: "cascade" }),
    start: integer("start").notNull(),
    end: integer("end").notNull(),
  },
  (table) => [index("scheduled_moods_room").on(table.roomId, table.start)],
);

// How a room, a zone or the home turns its lights on, where the household
// chose (v1's target settings); a target with no row follows its
// schedule. A target is a kind with an id, the home's being "home", as
// v1 keyed them; only rooms are offered.
export const turnOnSettings = sqliteTable(
  "turn_on_settings",
  {
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    behaviour: text("behaviour").$type<TurnOnBehaviour>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.targetKind, table.targetId] })],
);

// Each target's lights as they were when it last went dark (v1's light
// snapshots, light-snapshots-db.ts): those that went off together with the
// last one with the look they had, and the others off.
export const snapshotLights = sqliteTable(
  "snapshot_lights",
  {
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    deviceId: text("device_id").notNull(),
    capabilityId: text("capability_id").notNull(),
    state: text("state", { mode: "json" }).$type<MoodLightState>().notNull(),
    takenAt: text("taken_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.targetKind,
        table.targetId,
        table.deviceId,
        table.capabilityId,
      ],
    }),
  ],
);

// The lights.turnOn Moods last published for each room (turn-on.ts), as
// for its moods' entities: a row outlives its room until its entity is out
// of the home, and a null state is a publication still to confirm.
export const turnOnEntities = sqliteTable("turn_on_entities", {
  roomId: text("room_id").primaryKey(),
  state: text("state", { mode: "json" }).$type<TurnOn>(),
});

// What motion does to a room's lights (motion/), from which Moods keeps a
// workflow for each: whether motion turns them on, only below a light
// level in lux if one is chosen, and after how many minutes with no motion
// they turn off, none leaving them on. A room with no row has neither.
export const motionSettings = sqliteTable("motion_settings", {
  roomId: text("room_id").primaryKey(),
  turnOn: integer("turn_on", { mode: "boolean" }).notNull().default(false),
  darkerThan: integer("darker_than"),
  turnOffAfter: integer("turn_off_after"),
});
