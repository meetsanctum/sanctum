import { platforms } from "@meetsanctum/auth-protocol";
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
    // Reduce effects and Reduce motion, each on or off on its own, set on
    // any client.
    reduceEffects: integer("reduced_effects", { mode: "boolean" })
      .notNull()
      .default(false),
    reduceMotion: integer("reduced_motion", { mode: "boolean" })
      .notNull()
      .default(false),
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

// Shared devices' pairing requests. The lookup is the display code's first
// characters, which the core gives the device; the rest is the device's own
// secret, never sent, which the core holds only in memory while an exchange
// runs (pairing.ts). Only the device secret's hash is kept. A request stays
// here 10 minutes after it expires or is used up, so its lookup rests before
// another request gets it: a code read off one device never reaches another.
export const authPairingRequests = sqliteTable("auth_pairing_requests", {
  id: text("id").primaryKey(),
  lookup: text("lookup").notNull().unique(),
  deviceSecretHash: text("device_secret_hash").notNull().unique(),
  platform: text("platform", { enum: platforms }).notNull(),
  suggestedName: text("suggested_name").notNull(),
  // The connection's own address, for the per-address cap.
  sourceAddress: text("source_address").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  // When it can no longer be approved or collected; brought forward when
  // its exchanges run out.
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  // The exchanges started with the device, each counted as it starts.
  exchanges: integer("exchanges").notNull().default(0),
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

export const inviteKinds = ["invite", "reset", "recovery"] as const;
export const inviteEndings = ["cancelled"] as const;

// Invites to sign in, password resets and recovery codes. The inviting
// device draws the code's secret and registers it through OPAQUE, so the
// core holds a record, as for a password, never the code. Its lookup finds
// it. A reset leaves the person's login as it is until the code is used. An
// invite stays after it ends unused, with its lookup, so a right code typed
// late is told it ended and the invite list can give the reason. Using it
// or making the person a new one removes it. A person has one invite or
// reset at most, and beside it one recovery code: a reset with no end that
// they made for themselves, so a reset someone else makes leaves it.
export const authInvites = sqliteTable(
  "auth_invites",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: inviteKinds }).notNull(),
    lookup: text("lookup").notNull().unique(),
    registrationRecord: text("registration_record").notNull(),
    keyStretching: integer("key_stretching").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    // Challenges issued since the code last checked or the cooldown elapsed.
    // One extra count marks the first refusal during the cooldown.
    tries: integer("tries").notNull().default(0),
    lastTriedAt: integer("last_tried_at", { mode: "timestamp_ms" }),
    // Why it ended before it ran out, and when.
    endedReason: text("ended_reason", { enum: inviteEndings }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("auth_invites_person_id_ordinary")
      .on(table.personId)
      .where(sql`kind <> 'recovery'`),
    uniqueIndex("auth_invites_person_id_recovery")
      .on(table.personId)
      .where(sql`kind = 'recovery'`),
    check(
      "auth_invites_ordinary_expiry",
      sql`${table.kind} = 'recovery' OR ${table.expiresAt} IS NOT NULL`,
    ),
  ],
);
