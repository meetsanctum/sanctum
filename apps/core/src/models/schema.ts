import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// The home's AI models: the sources the household added, one of them in
// use, and the tokens each used by day.

/** A source: Ollama on a computer in the home, or a provider and its key. */
export const modelSources = sqliteTable("model_sources", {
  id: text("id").primaryKey(),
  kind: text("kind", {
    enum: ["computer", "openrouter", "openai"],
  }).notNull(),
  model: text("model").notNull(),
  modelName: text("model_name").notNull(),
  // A computer's name and its address, pinned as an IP address and a port.
  computer: text("computer"),
  host: text("host"),
  port: integer("port"),
  // A provider's key, sealed with the core's key, and its last four
  // characters to show.
  sealedKey: text("sealed_key"),
  keyEnd: text("key_end"),
  // At most one source is in use.
  inUse: integer("in_use", { mode: "boolean" }).notNull(),
  // How the last check went, as JSON (ModelCheck).
  check: text("check", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * The tokens a source read and wrote on a day of the home's, for what asked:
 * an app by its id, or `check` for Settings' checks.
 */
export const modelTokens = sqliteTable(
  "model_tokens",
  {
    day: text("day").notNull(),
    sourceId: text("source_id").notNull(),
    usedBy: text("used_by").notNull(),
    tokens: integer("tokens").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.sourceId, table.usedBy] }),
  ],
);
