import type {
  ClientInfo,
  ClientKind,
  Platform,
} from "@meetsanctum/auth-protocol";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import { AuthError } from "./errors.js";
import { authClients, authTokens } from "./schema.js";
import { hashToken, newClientToken } from "./tokens.js";

// Paired clients and their tokens, and the principal each request's token
// stands for.

export type Principal = {
  // Its name as it is now, which a run by hand on a shared client keeps.
  client: { id: string; kind: ClientKind; name: string };
  // Personal clients only.
  person?: { id: string };
  // Agents only: the person or shared client who added it.
  addedBy?: AddedBy;
  // An agent's token opens the MCP endpoint and nothing else (routes.ts).
  scope: "full" | "widgets" | "agent";
};

// Who added an agent.
export type AddedBy = { kind: "person" | "client"; id: string };

type Client = typeof authClients.$inferSelect;

// A successful request updates the client's last-seen time at most this
// often.
const lastSeenEveryMs = 60_000;

export function clientInfo(
  client: Client,
  currentId?: string,
  connectedSince?: Date | null,
): ClientInfo {
  return {
    id: client.id,
    name: client.name,
    kind: client.kind,
    platform: client.platform,
    personId: client.personId,
    createdAt: client.createdAt.toISOString(),
    lastSeenAt: client.lastSeenAt?.toISOString() ?? null,
    connectedSince: connectedSince?.toISOString() ?? null,
    current: client.id === currentId,
  };
}

// The live connections each client has open, so revoking it closes them,
// and since when.
export type Connections = {
  closeClient(clientId: string): void;
  connectedSince(clientId: string): Date | null;
};

export function createClients(
  db: CoreDatabase,
  options: {
    record: RecordActivity;
    connections: Connections;
    now: () => Date;
  },
) {
  const { record, connections, now } = options;

  // What every request and every entry a shared client leaves in the
  // activity log reads, each compiled once: the client a token stands for,
  // and a client's name.
  const byToken = db
    .select({ client: authClients })
    .from(authTokens)
    .innerJoin(authClients, eq(authTokens.clientId, authClients.id))
    .where(
      and(
        eq(authTokens.tokenHash, sql.placeholder("tokenHash")),
        eq(authTokens.kind, "client"),
        isNull(authTokens.revokedAt),
        isNull(authClients.revokedAt),
      ),
    )
    .prepare();
  const nameOf = db
    .select({ name: authClients.name })
    .from(authClients)
    .where(eq(authClients.id, sql.placeholder("id")))
    .prepare();

  function active(id: string) {
    return db
      .select()
      .from(authClients)
      .where(and(eq(authClients.id, id), isNull(authClients.revokedAt)))
      .get();
  }

  // Every client manages every other, shared ones too.
  function manageable(id: string) {
    const client = active(id);
    if (!client) {
      throw new AuthError("not_found");
    }
    return client;
  }

  function create(values: Omit<typeof authClients.$inferInsert, "id">) {
    const client = db
      .insert(authClients)
      .values({ id: randomUUID(), ...values })
      .returning()
      .get();
    const token = newClientToken();
    db.insert(authTokens)
      .values({
        id: randomUUID(),
        clientId: client.id,
        kind: "client",
        tokenHash: hashToken(token),
        createdAt: values.createdAt,
      })
      .run();
    return { client, token };
  }

  return {
    // Creates a personal client and its token. Called inside the claim's or
    // sign-in's transaction.
    createPersonal(input: {
      name: string;
      platform: Platform;
      personId: string;
    }) {
      const at = now();
      return create({
        ...input,
        kind: "personal",
        createdAt: at,
        createdBy: input.personId,
        lastSeenAt: at,
      });
    },

    // Creates a shared client and its token. Called inside the transaction
    // that collects an approved pairing request. It has not been seen until
    // its first request with the token.
    createShared(input: {
      name: string;
      platform: Platform;
      // The person who approved it, none on a shared client.
      approvedBy?: string;
    }) {
      return create({
        name: input.name,
        kind: "shared",
        platform: input.platform,
        createdAt: now(),
        createdBy: input.approvedBy,
      });
    },

    // Creates an agent and its token: an AI agent the person or shared
    // client adding it will be behind. It has not been seen until its first
    // request with the token.
    createAgent(input: { name: string; platform: Platform; addedBy: AddedBy }) {
      const { addedBy } = input;
      return create({
        name: input.name,
        kind: "agent",
        platform: input.platform,
        createdAt: now(),
        createdBy: addedBy.kind === "person" ? addedBy.id : undefined,
        addedByPersonId: addedBy.kind === "person" ? addedBy.id : null,
        addedByClientId: addedBy.kind === "client" ? addedBy.id : null,
      });
    },

    // The principal a client token stands for, or none when the token is
    // unknown or revoked. Checked against the database on every request, so
    // revoking takes effect at once.
    authenticate(token: string): Principal | undefined {
      const found = byToken.get({ tokenHash: hashToken(token) });
      if (!found) {
        return undefined;
      }
      const { client } = found;
      const at = now();
      if (
        !client.lastSeenAt ||
        at.getTime() - client.lastSeenAt.getTime() >= lastSeenEveryMs
      ) {
        db.update(authClients)
          .set({ lastSeenAt: at })
          .where(eq(authClients.id, client.id))
          .run();
      }
      if (client.kind === "agent") {
        return {
          client: { id: client.id, kind: client.kind, name: client.name },
          addedBy: client.addedByPersonId
            ? { kind: "person", id: client.addedByPersonId }
            : { kind: "client", id: client.addedByClientId ?? "" },
          scope: "agent",
        };
      }
      return {
        client: { id: client.id, kind: client.kind, name: client.name },
        ...(client.personId ? { person: { id: client.personId } } : {}),
        scope: "full",
      };
    },

    info(principal: Principal) {
      const client = active(principal.client.id);
      if (!client) {
        throw new AuthError("invalid_client_token");
      }
      return clientInfo(client, client.id);
    },

    // A client's name, revoked or not, for the activity log.
    name(id: string): string | null {
      return nameOf.get({ id })?.name ?? null;
    },

    // Who added an agent, revoked or not, for the activity log; none for
    // another client, or an agent that went with its person.
    addedBy(id: string): AddedBy | null {
      const client = db
        .select({
          person: authClients.addedByPersonId,
          client: authClients.addedByClientId,
        })
        .from(authClients)
        .where(eq(authClients.id, id))
        .get();
      if (client?.person) return { kind: "person", id: client.person };
      if (client?.client) return { kind: "client", id: client.client };
      return null;
    },

    // Every client sees every client. Agents aren't devices people use, so
    // they aren't among them.
    list(principal: Principal): ClientInfo[] {
      return db
        .select()
        .from(authClients)
        .where(
          and(isNull(authClients.revokedAt), ne(authClients.kind, "agent")),
        )
        .orderBy(asc(authClients.createdAt))
        .all()
        .map((client) =>
          clientInfo(
            client,
            principal.client.id,
            connections.connectedSince(client.id),
          ),
        );
    },

    rename(principal: Principal, input: { id: string; name: string }) {
      return db.transaction(() => {
        manageable(input.id);
        const renamed = db
          .update(authClients)
          .set({ name: input.name })
          .where(eq(authClients.id, input.id))
          .returning()
          .get()!;
        record({
          action: "client.rename",
          outcome: "ok",
          personId: principal.person?.id,
          clientId: principal.client.id,
          subjectId: input.id,
        });
        return clientInfo(renamed, principal.client.id);
      });
    },

    // Signs every device out after a restore from a backup: every client and
    // its tokens, so each one returns to the pairing screen. Called inside the
    // restore's transaction, before the core serves anyone, along with
    // dropping pairing requests (Auth's signOutEveryone).
    revokeAll(at: Date) {
      const clients = db
        .update(authClients)
        .set({ revokedAt: at })
        .where(isNull(authClients.revokedAt))
        .returning({ id: authClients.id })
        .all();
      db.update(authTokens)
        .set({ revokedAt: at })
        .where(isNull(authTokens.revokedAt))
        .run();
      return clients.length;
    },

    // Refused from its next request on; its live connections close now. The
    // agents it added go with it.
    revoke(principal: Principal, input: { id: string }) {
      db.transaction(() => {
        manageable(input.id);
        const at = now();
        const revoked = db
          .update(authClients)
          .set({ revokedAt: at })
          .where(
            and(
              isNull(authClients.revokedAt),
              or(
                eq(authClients.id, input.id),
                eq(authClients.addedByClientId, input.id),
              ),
            ),
          )
          .returning({ id: authClients.id })
          .all();
        db.update(authTokens)
          .set({ revokedAt: at })
          .where(
            and(
              inArray(
                authTokens.clientId,
                revoked.map((client) => client.id),
              ),
              isNull(authTokens.revokedAt),
            ),
          )
          .run();
        record({
          action: "client.revoke",
          outcome: "ok",
          personId: principal.person?.id,
          clientId: principal.client.id,
          subjectId: input.id,
        });
      });
      connections.closeClient(input.id);
    },
  };
}

export type Clients = ReturnType<typeof createClients>;
