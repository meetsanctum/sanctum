import type {
  ClientInfo,
  ClientKind,
  LiveClientChanged,
  Platform,
  SetClientDrawing,
} from "@meetsanctum/auth-protocol";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import { people } from "../people/schema.js";
import { AuthError } from "./errors.js";
import { authAgentSetups, authClients, authTokens } from "./schema.js";
import { hashToken, newClientToken } from "./tokens.js";

// Paired clients and their tokens, and the principal each request's token
// stands for.

export type Principal = {
  // Its name as it is now, which a run by hand on a shared client keeps.
  client: { id: string; kind: ClientKind; name: string };
} & (
  | { scope: "full" | "widgets"; person?: { id: string } }
  | { scope: "agent"; person?: never; addedBy: AddedBy }
);

// Who added an agent.
export type AddedBy = { kind: "person" | "client"; id: string };

type Client = typeof authClients.$inferSelect;

function addedByOf(
  client: Pick<Client, "addedByPersonId" | "addedByClientId">,
): AddedBy | null {
  if (client.addedByPersonId)
    return { kind: "person", id: client.addedByPersonId };
  if (client.addedByClientId)
    return { kind: "client", id: client.addedByClientId };
  return null;
}

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
    reduceEffects: client.reduceEffects,
    reduceMotion: client.reduceMotion,
  };
}

// The live connections each client has open, so revoking it closes them,
// and since when, and a change to it reaches it at once.
export type Connections = {
  closeClient(clientId: string): void;
  connectedSince(clientId: string): Date | null;
  tell(clientId: string, message: object): void;
};

function activePersonalClients(personId: string) {
  return and(
    eq(authClients.personId, personId),
    eq(authClients.kind, "personal"),
    isNull(authClients.revokedAt),
  )!;
}

// A confirmation only covers the devices it showed. Check in the same
// transaction as the removal, before any of those devices are signed out.
export function assertPersonalClients(
  db: Pick<CoreDatabase, "select">,
  personId: string,
  expectedClientIds: readonly string[] | undefined,
) {
  if (!expectedClientIds) return;
  const expected = new Set(expectedClientIds);
  const current = db
    .select({ id: authClients.id })
    .from(authClients)
    .where(activePersonalClients(personId))
    .all();
  if (
    expected.size !== current.length ||
    current.some(({ id }) => !expected.has(id))
  ) {
    throw new AuthError("devices_changed");
  }
}

export function createClients(
  db: CoreDatabase,
  options: {
    record: RecordActivity;
    connections: Connections;
    now: () => Date;
  },
) {
  const { record, connections, now } = options;

  function revokeMatchingClients(affected: SQL, at: Date) {
    db.update(authTokens)
      .set({ revokedAt: at })
      .where(
        and(
          inArray(
            authTokens.clientId,
            db.select({ id: authClients.id }).from(authClients).where(affected),
          ),
          isNull(authTokens.revokedAt),
        ),
      )
      .run();
    return db
      .update(authClients)
      .set({ revokedAt: at })
      .where(affected)
      .returning({
        id: authClients.id,
        name: authClients.name,
        kind: authClients.kind,
      })
      .all();
  }

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

  const activeById = db
    .select()
    .from(authClients)
    .where(
      and(
        eq(authClients.id, sql.placeholder("id")),
        isNull(authClients.revokedAt),
      ),
    )
    .prepare();
  const addedByOfAgent = db
    .select({
      addedByPersonId: authClients.addedByPersonId,
      addedByClientId: authClients.addedByClientId,
    })
    .from(authClients)
    .where(
      and(
        eq(authClients.id, sql.placeholder("id")),
        eq(authClients.kind, "agent"),
      ),
    )
    .prepare();
  const personById = db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.id, sql.placeholder("id")))
    .prepare();
  const setupOfAgent = db
    .select({
      id: authAgentSetups.id,
      expiresAt: authAgentSetups.expiresAt,
      cancelledAt: authAgentSetups.cancelledAt,
    })
    .from(authAgentSetups)
    .where(eq(authAgentSetups.clientId, sql.placeholder("id")))
    .prepare();

  // A client that is there, unrevoked. Prepared, since the gate asks it on
  // every call an agent sends.
  function active(id: string) {
    return activeById.get({ id });
  }

  function canAddAgent(addedBy: AddedBy): boolean {
    return addedBy.kind === "client"
      ? active(addedBy.id)?.kind === "shared"
      : personById.get({ id: addedBy.id }) !== undefined;
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

  function markSeen(client: Client, at = now()) {
    if (
      !client.lastSeenAt ||
      at.getTime() - client.lastSeenAt.getTime() >= lastSeenEveryMs
    ) {
      db.update(authClients)
        .set({ lastSeenAt: at })
        .where(eq(authClients.id, client.id))
        .run();
    }
  }

  return {
    canAddAgent,
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
      return db.transaction(() => {
        // Added by someone in the household, or a shared device in use.
        if (!canAddAgent(addedBy)) {
          throw new AuthError("forbidden");
        }
        return create({
          name: input.name,
          kind: "agent",
          platform: input.platform,
          createdAt: now(),
          addedByPersonId: addedBy.kind === "person" ? addedBy.id : null,
          addedByClientId: addedBy.kind === "client" ? addedBy.id : null,
        });
      });
    },

    // The principal a client token stands for, or none when the token is
    // unknown or revoked. Checked against the database on every request, so
    // revoking takes effect at once. Only the MCP route marks an agent seen.
    authenticate(
      token: string,
      { recordAgentSeen = false } = {},
    ): Principal | undefined {
      const found = byToken.get({ tokenHash: hashToken(token) });
      if (!found) {
        return undefined;
      }
      const { client } = found;
      const identity = { id: client.id, kind: client.kind, name: client.name };
      if (client.kind === "agent") {
        const addedBy = addedByOf(client);
        if (!addedBy) return undefined;
        const setup = client.lastSeenAt
          ? undefined
          : setupOfAgent.get({ id: client.id });
        const at = now();
        // The deadline holds even if nobody has checked the setup yet.
        if (setup && (setup.cancelledAt || setup.expiresAt <= at)) {
          return undefined;
        }
        if (recordAgentSeen) {
          if (setup) {
            db.transaction(() => {
              db.update(authAgentSetups)
                .set({ connectedAt: at })
                .where(eq(authAgentSetups.id, setup.id))
                .run();
              markSeen(client, at);
            });
          } else {
            markSeen(client, at);
          }
        }
        return { client: identity, addedBy, scope: "agent" };
      }
      markSeen(client);
      return {
        client: identity,
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

    // Whether an agent is still there, unrevoked: what it sends on is
    // refused once it isn't (the gate).
    isActiveAgent(id: string): boolean {
      return active(id)?.kind === "agent";
    },

    // Who added an agent, revoked or not, for the activity log; none for
    // another client, or an agent that went with its person.
    addedBy(id: string): AddedBy | null {
      const client = addedByOfAgent.get({ id });
      return client ? addedByOf(client) : null;
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
          detail:
            renamed.kind === "agent"
              ? { kind: renamed.kind, name: renamed.name }
              : undefined,
        });
        return clientInfo(renamed, principal.client.id);
      });
    },

    // Whether a client draws with Reduce effects and Reduce motion, each set
    // on its own on any client as its name is, and told to it at once so it
    // draws so without waiting to read Me again. Not for an agent, which
    // draws nothing.
    setDrawing(principal: Principal, input: SetClientDrawing) {
      const { saved, changed } = db.transaction(() => {
        const client = manageable(input.id);
        if (client.kind === "agent") {
          throw new AuthError("not_found");
        }
        const reduceEffects = input.reduceEffects ?? client.reduceEffects;
        const reduceMotion = input.reduceMotion ?? client.reduceMotion;
        if (
          reduceEffects === client.reduceEffects &&
          reduceMotion === client.reduceMotion
        ) {
          return { saved: client, changed: false };
        }
        const saved = db
          .update(authClients)
          .set({ reduceEffects, reduceMotion })
          .where(eq(authClients.id, input.id))
          .returning()
          .get()!;
        return { saved, changed: true };
      });
      if (changed) {
        connections.tell(input.id, {
          type: "client",
        } satisfies LiveClientChanged);
      }
      return clientInfo(
        saved,
        principal.client.id,
        connections.connectedSince(saved.id),
      );
    },

    // The home's agents that have reached it, oldest first: one whose setup
    // hasn't connected yet isn't listed until it does.
    listAgents() {
      return db
        .select()
        .from(authClients)
        .where(
          and(
            isNull(authClients.revokedAt),
            eq(authClients.kind, "agent"),
            isNotNull(authClients.lastSeenAt),
          ),
        )
        .orderBy(asc(authClients.createdAt))
        .all()
        .flatMap((agent) => {
          const addedBy = addedByOf(agent);
          return addedBy ? [{ ...agent, addedBy }] : [];
        });
    },

    // Takes back an agent's token without anyone asking, as when its setup
    // runs out before it connects or is cancelled. Logged by the setup.
    revokeUnconnectedAgent(id: string) {
      const at = now();
      db.transaction(() => {
        const revoked = db
          .update(authClients)
          .set({ revokedAt: at })
          .where(
            and(
              eq(authClients.id, id),
              eq(authClients.kind, "agent"),
              isNull(authClients.lastSeenAt),
              isNull(authClients.revokedAt),
            ),
          )
          .returning({ id: authClients.id })
          .get();
        if (!revoked) return;
        db.update(authTokens)
          .set({ revokedAt: at })
          .where(and(eq(authTokens.clientId, id), isNull(authTokens.revokedAt)))
          .run();
      });
    },

    // Revokes all clients and tokens inside the restore's transaction, before
    // the core serves anyone. Counts signed-out devices for the activity log.
    revokeAll(at: Date) {
      const clients = db
        .update(authClients)
        .set({ revokedAt: at })
        .where(isNull(authClients.revokedAt))
        .returning({ kind: authClients.kind })
        .all();
      db.update(authTokens)
        .set({ revokedAt: at })
        .where(isNull(authTokens.revokedAt))
        .run();
      return clients.filter(({ kind }) => kind !== "agent").length;
    },

    // Sign out a person's own devices in the caller's transaction. The
    // caller closes their live connections once it commits.
    revokePersonal(
      personId: string,
      at: Date,
      expectedClientIds?: readonly string[],
    ): string[] {
      assertPersonalClients(db, personId, expectedClientIds);
      return revokeMatchingClients(activePersonalClients(personId), at).map(
        ({ id }) => id,
      );
    },

    close(ids: readonly string[]) {
      for (const id of ids) connections.closeClient(id);
    },

    // Refused from its next request on; its live connections close now. The
    // agents it added go with it.
    revoke(principal: Principal, input: { id: string }) {
      db.transaction(() => {
        manageable(input.id);
        const at = now();
        const affected = and(
          isNull(authClients.revokedAt),
          or(
            eq(authClients.id, input.id),
            eq(authClients.addedByClientId, input.id),
          ),
        )!;
        const revoked = revokeMatchingClients(affected, at);
        // One entry for the client, and one for each agent it took along.
        for (const { id, kind, name } of revoked) {
          record({
            action: "client.revoke",
            outcome: "ok",
            personId: principal.person?.id,
            clientId: principal.client.id,
            subjectId: id,
            detail: kind === "agent" ? { kind, name } : undefined,
          });
        }
      });
      connections.closeClient(input.id);
    },
  };
}

export type Clients = ReturnType<typeof createClients>;
