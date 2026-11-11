import type {
  Actor,
  Availability,
  CapabilityKind,
  FirmwareInfo,
  SyncStatus,
} from "@meetsanctum/app-sdk";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { rooms } from "../places/schema.js";

// Devices: the registry of what driver apps bring in, and each device's
// typed capabilities with their state. What a device reported and what a
// command asked of it are kept apart.

export type StoredSetBy = {
  app: string | null;
  actor: Actor;
  asked: Record<string, unknown>;
  at: string;
};

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    // The app that brings it, such as sanctum.zigbee, and that app's own key
    // for it, such as its Zigbee address.
    driver: text("driver").notNull(),
    key: text("key").notNull(),
    // What the driver calls it, and its own name: the one the household
    // gave it, or one the core made up from its room and type (naming.ts)
    // until then. Without either it goes by its driver's name.
    driverName: text("driver_name").notNull(),
    name: text("name"),
    autoNamed: integer("auto_named", { mode: "boolean" })
      .notNull()
      .default(false),
    manufacturer: text("manufacturer"),
    model: text("model"),
    // Removing a room keeps its devices, in no room.
    roomId: text("room_id").references(() => rooms.id, {
      onDelete: "set null",
    }),
    availability: text("availability").$type<Availability>().notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    // What it runs and what an update is doing, where its driver can tell
    // (firmware.ts), and whether Check connection can ask it how it is.
    firmware: text("firmware", { mode: "json" }).$type<FirmwareInfo>(),
    probe: integer("probe", { mode: "boolean" }).notNull().default(false),
    // Its battery's charge in percent, as its driver last reported it.
    battery: integer("battery"),
    // When its driver said its network no longer has it, as after a reset,
    // until a list of the network has it again.
    leftAt: integer("left_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("devices_driver_key").on(table.driver, table.key),
    index("devices_room_id").on(table.roomId),
  ],
);

export const deviceCapabilities = sqliteTable(
  "device_capabilities",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    // Unique within its device, such as "light", or "l1" and "l2".
    id: text("id").notNull(),
    kind: text("kind").$type<CapabilityKind>().notNull(),
    // Its order on the device, as the driver listed it.
    position: integer("position").notNull(),
    features: text("features", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    // What the device last reported (a light that is off keeps the
    // brightness it comes back at, sync.ts), and the fields a command asked
    // for until the device confirms them.
    observed: text("observed", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    desired: text("desired", { mode: "json" }).$type<Record<string, unknown>>(),
    sync: text("sync").$type<SyncStatus>().notNull(),
    // While a command is pending, the on and off of earlier commands that
    // the device has yet to report (sync.ts).
    awaiting: text("awaiting", { mode: "json" }).$type<boolean[]>(),
    // The last command the core carried out for it: the app that sent it,
    // if any, the actor behind it, the fields it asked for and when.
    setBy: text("set_by", { mode: "json" }).$type<StoredSetBy>(),
    // When what it reports last changed: its kind's history fields, such as
    // whether a motion sensor sees someone. Commands, settings and reports
    // that say the same again leave it, unlike updatedAt.
    changedAt: integer("changed_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.id] })],
);
