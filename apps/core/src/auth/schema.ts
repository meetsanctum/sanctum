import { platforms } from "@meetsanctum/auth-protocol";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { people } from "../people/schema.js";

// Auth's tables. Tokens are stored only as SHA-256 hashes; passwords never
// reach the host at all.

export const authServer = sqliteTable("auth_server", {
  // Always 1: the host has one OPAQUE server setup.
  id: integer("id").primaryKey(),
  // The host's OPAQUE key. It is in the backups, since a new one would
  // invalidate every password.
  serverSetup: text("server_setup").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  // The claimed flag: set in the claim's transaction and never cleared,
  // except by a reset of the host.
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
});

export const authLogins = sqliteTable("auth_logins", {
  personId: text("person_id")
    .primaryKey()
    .references(() => people.id, { onDelete: "cascade" }),
  username: text("username").notNull().unique(),
  // The OPAQUE registration record the person's device made.
  registrationRecord: text("registration_record").notNull(),
  // The key-stretching parameters' version the record was made with.
  keyStretching: integer("key_stretching").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const clientKinds = ["personal", "shared"] as const;

export const authClients = sqliteTable(
  "auth_clients",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: clientKinds }).notNull(),
    // A personal client's person; removing the person removes the client.
    personId: text("person_id").references(() => people.id, {
      onDelete: "cascade",
    }),
    platform: text("platform", { enum: platforms }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    // The person who signed in on it, or the person who approved it.
    createdBy: text("created_by"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    check(
      "auth_clients_person",
      sql`(${table.kind} = 'personal') = (${table.personId} is not null)`,
    ),
  ],
);

export const tokenKinds = ["client", "widget"] as const;

export const authTokens = sqliteTable(
  "auth_tokens",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => authClients.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: tokenKinds }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("auth_tokens_client_id").on(table.clientId)],
);

// Shared devices' pairing requests. Only the display code's and the device
// secret's hashes are kept. A request stays here until it expires, 10
// minutes after it was made, even once used up, so a used code is refused
// rather than unknown.
export const authPairingRequests = sqliteTable("auth_pairing_requests", {
  id: text("id").primaryKey(),
  // Unique among the requests kept, which are swept once they expire.
  codeHash: text("code_hash").notNull().unique(),
  deviceSecretHash: text("device_secret_hash").notNull().unique(),
  platform: text("platform", { enum: platforms }).notNull(),
  suggestedName: text("suggested_name").notNull(),
  // The connection's own address, for the per-address cap and for whoever
  // approves it to see.
  sourceAddress: text("source_address").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  // The person who approved it, none on a shared client, and the name they
  // gave the device. No reference, as in the activity log.
  approvedBy: text("approved_by"),
  approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
  name: text("name"),
  // The client collecting created, which used the request up.
  clientId: text("client_id"),
});
