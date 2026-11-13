import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Apps' settings: what the household chose for each app's preferences, by
// setting name. The app's schema fills in its defaults whenever they are
// read, so nothing here is a default.

export const appSettings = sqliteTable("app_settings", {
  appId: text("app_id").primaryKey(),
  values: text("values", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// Apps' grants: whether the household lets an app have each permission it
// has asked for. A row stays when a new version stops asking, so asking
// again finds the household's answer.

export const appGrants = sqliteTable(
  "app_grants",
  {
    appId: text("app_id").notNull(),
    permission: text("permission").notNull(),
    granted: integer("granted", { mode: "boolean" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.permission] })],
);

// The version each app last started on, which tells a first start and an update
// from any other.

export const appVersions = sqliteTable("app_versions", {
  appId: text("app_id").primaryKey(),
  version: text("version").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  // For an app apart: what it holds, the folder of its package, and the update this
  // row commits.
  digest: text("digest"),
  folder: text("folder"),
  updateId: text("update_id"),
  // Its settings before the update this row commits, for going back from it.
  settingsBefore: text("settings_before", { mode: "json" }).$type<
    Record<string, unknown>
  >(),
});

// An app's update under way, or one that failed, until another version
// arrives (updates.ts).

export const appUpdates = sqliteTable("app_updates", {
  appId: text("app_id").primaryKey(),
  id: text("id").notNull(),
  fromVersion: text("from_version").notNull(),
  fromFolder: text("from_folder").notNull(),
  toVersion: text("to_version").notNull(),
  toFolder: text("to_folder").notNull(),
  status: text("status", {
    enum: ["waiting", "starting", "undoing", "restored", "undone"],
  }).notNull(),
  // Its settings as they stood, for what the old version won't accept.
  settings: text("settings", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull(),
  // What stopped the new version.
  failure: text("failure"),
  // When a version that wasn't ready is tried again, which doesn't count against it.
  retryAt: integer("retry_at", { mode: "timestamp_ms" }),
  // Someone going back: the update whose kept copy goes in place.
  restores: text("restores"),
  // Undone because someone went back, rather than because this version failed.
  chosen: integer("chosen", { mode: "boolean" }).notNull().default(false),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
});

// The apps someone has turned off in their settings. They stay off across
// restarts and new versions, until someone turns them on.

export const appsOff = sqliteTable("apps_off", {
  appId: text("app_id").primaryKey(),
  turnedOffAt: integer("turned_off_at", { mode: "timestamp_ms" }).notNull(),
});

// Apps' own secrets, such as their devices' keys (secrets.ts), each sealed
// with AES-256-GCM under the key in the core's data folder: what's here
// says nothing on its own. They stay as long as the app's database does.

export const appSecrets = sqliteTable(
  "app_secrets",
  {
    appId: text("app_id").notNull(),
    name: text("name").notNull(),
    // Base64 of its nonce, its tag and the value sealed.
    sealed: text("sealed").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.name] })],
);
