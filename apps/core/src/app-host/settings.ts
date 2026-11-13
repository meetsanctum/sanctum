import type { AppSettings, SettingsSchema } from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { CoreDatabase } from "../database.js";
import { schemaCheck, type SchemaCheck } from "./contract.js";
import type { Rule } from "./gate.js";
import { appSettings } from "./schema.js";

// Apps' settings: each app's preferences, as its manifest's settings schema
// declares them. The core keeps what was chosen and fills in the schema's
// defaults whenever they are read, so a new version's defaults reach what
// nobody chose, and a choice a new version no longer allows falls back to
// its default. They are the household's preferences, never secrets or one
// person's own: every client of the home reads and changes them, shared ones
// too. Removing an app keeps them, as it keeps its database.

// Changing an app's settings.
export const settingsRule: Rule = { tier: "write" };

// What a client sends: new values by name, and null to go back to the
// default. The app's schema checks each name and value, its maxLength
// included, and the core's request limit bounds the rest.
export const settingsChanges = z
  .record(
    z.string().min(1),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  )
  .refine((changes) => Object.keys(changes).length > 0, "change a setting");
export type SettingsChanges = z.output<typeof settingsChanges>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// One check per setting, from the schema in the app's manifest. Choices that
// depend on each other are the app's to weigh as it reads them
// (settingsAsRead in the SDK).
const checks = new WeakMap<SettingsSchema, Map<string, SchemaCheck>>();
function checksOf(schema: SettingsSchema) {
  let found = checks.get(schema);
  if (!found) {
    found = new Map(
      Object.entries(schema.properties).map(([name, property]) => [
        name,
        schemaCheck(property),
      ]),
    );
    checks.set(schema, found);
  }
  return found;
}

// The choices the schema still declares and allows.
function fitting(schema: SettingsSchema, chosen: Record<string, unknown>) {
  const all = checksOf(schema);
  return Object.fromEntries(
    Object.entries(chosen).filter(
      ([name, value]) => all.get(name)?.(value).success,
    ),
  );
}

// An app's settings with its schema's defaults for what nobody chose.
function resolve(schema: SettingsSchema, chosen: Record<string, unknown>) {
  const defaults = Object.entries(schema.properties).flatMap(
    ([name, property]) =>
      property.default === undefined ? [] : [[name, property.default]],
  );
  return {
    ...Object.fromEntries(defaults),
    ...fitting(schema, chosen),
  } as AppSettings;
}

export function createAppSettings(
  db: CoreDatabase,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());

  // What the household chose for an app, by setting name.
  function chosen(appId: string): Record<string, unknown> {
    const row = db
      .select()
      .from(appSettings)
      .where(eq(appSettings.appId, appId))
      .get();
    return isRecord(row?.values) ? row.values : {};
  }

  return {
    chosen,

    // Going back failed: restore the choices from before it, including any that
    // had to fall back while the older version was starting.
    restore(appId: string, values: Record<string, unknown>) {
      const set = { values, updatedAt: now() };
      db.insert(appSettings)
        .values({ appId, ...set })
        .onConflictDoUpdate({ target: appSettings.appId, set })
        .run();
    },

    // An update was undone. Settings stay as people set them where the old version
    // accepts them, and otherwise return to what the core recorded before it began.
    // Part of a transaction, so it never writes an activity entry of its own.
    settleAfterUndo(
      appId: string,
      schema: SettingsSchema | null,
      recorded: Record<string, unknown>,
    ) {
      if (!schema) return;
      const all = checksOf(schema);
      const current = chosen(appId);
      const next: Record<string, unknown> = {};
      for (const name of Object.keys(schema.properties)) {
        const check = all.get(name)!;
        if (name in current && check(current[name]).success) {
          next[name] = current[name];
        } else if (name in recorded && check(recorded[name]).success) {
          next[name] = recorded[name];
        }
      }
      const set = { values: next, updatedAt: now() };
      db.insert(appSettings)
        .values({ appId, ...set })
        .onConflictDoUpdate({ target: appSettings.appId, set })
        .run();
    },

    of(appId: string, schema: SettingsSchema | null): AppSettings {
      return schema ? resolve(schema, chosen(appId)) : {};
    },

    // Applies someone's changes and writes their activity entry in one
    // transaction. Undefined, and nothing changed, when the app declares
    // no such setting or its schema refuses a value.
    change(
      appId: string,
      schema: SettingsSchema | null,
      changes: SettingsChanges,
      record: () => void,
    ): AppSettings | undefined {
      if (
        !schema ||
        Object.keys(changes).some(
          (name) => !Object.hasOwn(schema.properties, name),
        )
      ) {
        return undefined;
      }
      const all = checksOf(schema);
      const next = { ...fitting(schema, chosen(appId)) };
      for (const [name, value] of Object.entries(changes)) {
        if (value === null) {
          delete next[name];
        } else if (all.get(name)?.(value).success) {
          next[name] = value;
        } else {
          return undefined;
        }
      }
      db.transaction(() => {
        const set = { values: next, updatedAt: now() };
        db.insert(appSettings)
          .values({ appId, ...set })
          .onConflictDoUpdate({ target: appSettings.appId, set })
          .run();
        record();
      });
      return resolve(schema, next);
    },
  };
}

export type AppSettingsStore = ReturnType<typeof createAppSettings>;
