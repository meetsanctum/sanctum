import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ESPHome's own database: what its devices' connections last told, for each
// device's page, so it shows while a device is out of reach and after a
// restart. Which devices it has is the core's record, and their keys are
// its secrets, so a rollback of this file parts no device from its key.
export const deviceFacts = sqliteTable("device_facts", {
  // The device's MAC address, its key in the core.
  mac: text("mac").primaryKey(),
  // Where it was reached last, as host:port.
  address: text("address").notNull(),
  encrypted: integer("encrypted", { mode: "boolean" }).notNull(),
  // The ESPHome version it runs.
  version: text("version"),
  // Its Wi-Fi signal in dBm, where it says it.
  signal: real("signal"),
  // What it has that Sanctum doesn't use, by the names it gives them.
  unused: text("unused", { mode: "json" }).$type<string[]>().notNull(),
  // Whether it's built to sleep, so it's never offline while it does.
  sleeps: integer("sleeps", { mode: "boolean" }).notNull(),
  // How the key Sanctum gave it reached it, as its last key was given:
  // "setup" for older firmware, which took a setup key in the clear, then
  // its own encrypted.
  firstKey: text("first_key", { enum: ["setup"] }),
  // When a smart speaker last heard its wake word, in ms since the epoch.
  heardWakeWordAt: integer("heard_wake_word_at"),
});
