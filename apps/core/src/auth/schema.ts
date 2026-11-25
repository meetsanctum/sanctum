import {
  drawingChoices,
  platforms,
  type Drawn,
} from "@meetsanctum/auth-protocol";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
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

export const clientKinds = ["personal", "shared", "agent"] as const;

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
    // Who added an agent: a person, or a shared client. An agent goes with
    // them: removing the person removes it, revoking the client revokes it
    // (clients.ts).
    addedByPersonId: text("added_by_person_id").references(() => people.id, {
      onDelete: "cascade",
    }),
    addedByClientId: text("added_by_client_id").references(
      (): AnySQLiteColumn => authClients.id,
      { onDelete: "cascade" },
    ),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    // Reduce effects and Reduce motion as chosen for it, on any client.
    reduceEffects: text("reduce_effects", { enum: drawingChoices })
      .notNull()
      .default("automatic"),
    reduceMotion: text("reduce_motion", { enum: drawingChoices })
      .notNull()
      .default("automatic"),
    drawingRevision: integer("drawing_revision").notNull().default(0),
    // What the client last said it draws with (ClientInfo's drawn), as JSON;
    // Automatic is resolved on the device, which alone knows what it is.
    drawn: text("drawn", { mode: "json" }).$type<Drawn>(),
  },
  (table) => [
    check(
      "auth_clients_person",
      sql`(${table.kind} = 'personal') = (${table.personId} is not null)`,
    ),
    // An agent has exactly one who added it; no other client has one.
    check(
      "auth_clients_added_by",
      sql`((${table.addedByPersonId} is not null) + (${table.addedByClientId} is not null)) = (${table.kind} = 'agent')`,
    ),
  ],
);

export const tokenKinds = ["client", "widget", "page"] as const;

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

// AI agents' one-time setups. Only the secret's hash is kept. A setup stays
// here a day after it runs out, so its sheet can still tell how it ended.
export const authAgentSetups = sqliteTable(
  "auth_agent_setups",
  {
    id: text("id").primaryKey(),
    secretHash: text("secret_hash").notNull().unique(),
    // The name the agent will go by.
    name: text("name").notNull(),
    // Who started it, who the agent is added by: a person or a shared client.
    // No reference: collecting checks they're still there (clients.ts).
    addedByKind: text("added_by_kind", {
      enum: ["person", "client"],
    }).notNull(),
    addedById: text("added_by_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    // Wrong secrets sent for it; too many and it fails.
    wrongSecrets: integer("wrong_secrets").notNull().default(0),
    failedAt: integer("failed_at", { mode: "timestamp_ms" }),
    cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
    // The agent collecting created, and the address it collected from.
    clientId: text("client_id"),
    collectedFrom: text("collected_from"),
    // The agent's first authenticated call, kept when lastSeenAt changes.
    connectedAt: integer("connected_at", { mode: "timestamp_ms" }),
  },
  (table) => [uniqueIndex("auth_agent_setups_client_id").on(table.clientId)],
);
