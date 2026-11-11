import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The activity log: who did what, through which client, and how it ended.
// Entries hold ids and outcomes, with a few words of detail, never secrets,
// and outlive the people, clients and devices they name, so nothing here
// references them.

// "failed": an app's action threw or timed out, so what it changed is not
// known, or a device did not answer a command.
export const outcomes = ["ok", "refused", "failed"] as const;
export type Outcome = (typeof outcomes)[number];

// What an entry is about, which decides how long it is kept and which of
// the home's lists it shows in (kinds.ts).
export const kinds = ["devices", "automations", "setup", "system"] as const;
export type Kind = (typeof kinds)[number];

export const activity = sqliteTable(
  "activity",
  {
    id: text("id").primaryKey(),
    // When it happened, or the last time for an entry that joins several.
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    // The module or app that wrote it, such as "auth".
    source: text("source").notNull(),
    // What was attempted, such as "client.revoke".
    action: text("action").notNull(),
    // None only on entries from before kinds, until the core next starts.
    kind: text("kind", { enum: kinds }),
    outcome: text("outcome", { enum: outcomes }).notNull(),
    // Why it was refused or failed, as an error code.
    reason: text("reason"),
    // Who: the person and client behind the request, when there is one.
    personId: text("person_id"),
    clientId: text("client_id"),
    // A shared client's name as it was then, for once it is renamed or
    // removed.
    clientName: text("client_name"),
    // Who, when no person or client is behind it: a workflow or an app
    // acting on its own, such as workflow:<id> or app:sanctum.moods, a
    // device changed outside Sanctum, or Sanctum itself.
    actor: text("actor"),
    // The app whose code did it, as a capability's setBy.app says: Moods
    // for a mood a person chose.
    app: text("app"),
    // The entry behind it: the press that started a run, the run that
    // called an app's action, the action that sent a command.
    causeId: text("cause_id"),
    // What it was about, such as the client revoked or the login set.
    subjectId: text("subject_id"),
    // A few words of what it was: what a command asked for, a press's
    // action, how a run ended, a removed thing's name.
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
    // How many changes an entry joins, and when the first was.
    count: integer("count").notNull().default(1),
    firstAt: integer("first_at", { mode: "timestamp_ms" }),
    // The connection's address, for calls made before a principal exists.
    address: text("address"),
  },
  (table) => [
    index("activity_at").on(table.at),
    index("activity_subject").on(table.subjectId, table.at),
    index("activity_kind").on(table.kind, table.at),
    index("activity_cause").on(table.causeId),
  ],
);
