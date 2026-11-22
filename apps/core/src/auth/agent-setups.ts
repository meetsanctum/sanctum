import {
  agentConnectorProtocols,
  agentSetupCodeText,
  agentSetupMs,
  type AgentSetupStarted,
  type AgentSetupStatus,
  type AgentTokenCollected,
  type CollectAgentToken,
} from "@meetsanctum/auth-protocol";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";

import type { RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import { changedBy } from "./callers.js";
import type { AddedBy, Clients, Principal } from "./clients.js";
import { AuthError } from "./errors.js";
import { defaultLimits, type Limiter, type Limits } from "./limits.js";
import { shownAddress } from "./pairing.js";
import { authAgentSetups, authClients } from "./schema.js";
import { hashToken } from "./tokens.js";

// Adding an AI agent. Someone starts a setup and gets a code to paste into
// the agent; its connector checks it's this home before it sends the code's
// secret, which the core trades for the agent's token once. The setup waits
// until the agent's first call with that token, so the sheet that started it
// says it connected only once the agent can reach the home. One that
// doesn't connect in time runs out, and takes any token it gave with it.
// Wrong secrets are capped per address and per setup: a secret is 32 random
// bytes, so the caps only keep anyone from trying for long.

type Setup = typeof authAgentSetups.$inferSelect;

const setups = authAgentSetups;

// Wrong secrets a setup takes before it fails.
const wrongSecretsPerSetup = 5;
// How long a setup that ended is kept, so its sheet can say how.
const keptMs = 24 * 60 * 60_000;

function addedByOf(principal: Principal): AddedBy {
  if (principal.scope === "agent") throw new AuthError("forbidden");
  return principal.person
    ? { kind: "person", id: principal.person.id }
    : { kind: "client", id: principal.client.id };
}

export function createAgentSetups(
  db: CoreDatabase,
  options: {
    clients: Clients;
    record: RecordActivity;
    // Wrong secrets per address, like sign-ins' attempts.
    limiter: Limiter;
    homeId: string;
    pin: () => string | null;
    limits?: Limits;
    now: () => Date;
  },
) {
  const { clients, record, limiter, now } = options;
  const limits = options.limits ?? defaultLimits;

  // Removes setups that ended a day ago, and the agents of setups that ran
  // out before the agent's first call: nobody was told they connected.
  function settle() {
    const at = now();
    const unseen = db
      .select({ setupId: setups.id, clientId: authClients.id })
      .from(setups)
      .innerJoin(authClients, eq(authClients.id, setups.clientId))
      .where(
        and(
          lte(setups.expiresAt, at),
          isNull(setups.cancelledAt),
          isNull(authClients.lastSeenAt),
          isNull(authClients.revokedAt),
        ),
      )
      .all();
    for (const { clientId } of unseen) {
      clients.revokeAgent(clientId);
    }
    db.delete(setups)
      .where(lte(setups.expiresAt, new Date(at.getTime() - keptMs)))
      .run();
  }

  function status(setup: Setup): AgentSetupStatus {
    const { name } = setup;
    if (setup.cancelledAt) return { status: "cancelled", name };
    if (setup.failedAt) return { status: "failed", name };
    const agent = setup.clientId
      ? db
          .select()
          .from(authClients)
          .where(eq(authClients.id, setup.clientId))
          .get()
      : undefined;
    if (agent?.lastSeenAt && !agent.revokedAt) {
      return {
        status: "connected",
        agent: { id: agent.id, name: agent.name },
        address: shownAddress(setup.collectedFrom ?? ""),
        connectedAt: agent.lastSeenAt.toISOString(),
      };
    }
    // Ran out first: the token it gave out is taken back with it.
    if (setup.expiresAt.getTime() <= now().getTime()) {
      return { status: "expired", name };
    }
    // Signed out with the shared device that started it.
    if (agent?.revokedAt) return { status: "cancelled", name };
    return {
      status: "waiting",
      name,
      expiresAt: setup.expiresAt.toISOString(),
    };
  }

  return {
    /**
     * Starts a setup for an agent added by the caller, a person, or a shared
     * device in use. `url` is the address the caller reached the core at.
     */
    start(
      principal: Principal,
      input: { name: string },
      url: string,
    ): AgentSetupStarted {
      const addedBy = addedByOf(principal);
      const started = db.transaction(() => {
        settle();
        const open = db
          .select({ id: setups.id })
          .from(setups)
          .where(
            and(
              isNull(setups.clientId),
              isNull(setups.cancelledAt),
              isNull(setups.failedAt),
              gt(setups.expiresAt, now()),
            ),
          )
          .all();
        if (open.length >= limits.agentSetupsOpen) {
          throw new AuthError("busy");
        }
        const id = randomUUID();
        const secret = randomBytes(32).toString("base64url");
        const createdAt = now();
        const expiresAt = new Date(createdAt.getTime() + agentSetupMs);
        db.insert(setups)
          .values({
            id,
            secretHash: hashToken(secret),
            name: input.name,
            addedByKind: addedBy.kind,
            addedById: addedBy.id,
            createdAt,
            expiresAt,
          })
          .run();
        record({
          action: "agents.setup",
          outcome: "ok",
          ...changedBy(principal),
          subjectId: id,
          detail: { name: input.name },
        });
        return { id, secret, expiresAt };
      });
      return {
        setupId: started.id,
        code: agentSetupCodeText({
          homeId: options.homeId,
          pin: options.pin(),
          url,
          setupId: started.id,
          secret: started.secret,
        }),
        expiresAt: started.expiresAt.toISOString(),
      };
    },

    status(id: string): AgentSetupStatus {
      return db.transaction(() => {
        settle();
        const setup = db.select().from(setups).where(eq(setups.id, id)).get();
        if (!setup) throw new AuthError("not_found");
        return status(setup);
      });
    },

    // Stops a setup that hasn't connected, and removes the agent it gave a
    // token to. One that connected stays: removing its agent is Settings'.
    cancel(principal: Principal, id: string) {
      addedByOf(principal);
      const collected = db.transaction(() => {
        settle();
        const setup = db.select().from(setups).where(eq(setups.id, id)).get();
        if (!setup) throw new AuthError("not_found");
        if (status(setup).status !== "waiting") return undefined;
        db.update(setups)
          .set({ cancelledAt: now() })
          .where(eq(setups.id, id))
          .run();
        record({
          action: "agents.setup-cancel",
          outcome: "ok",
          ...changedBy(principal),
          subjectId: id,
          detail: { name: setup.name },
        });
        return setup.clientId ?? undefined;
      });
      if (collected) clients.revokeAgent(collected);
    },

    /**
     * The connector trades the code's secret for the agent's token, once.
     * Every setup it can't use is answered the same, so a wrong secret
     * learns nothing about the setup it names.
     */
    collect(address: string, input: CollectAgentToken): AgentTokenCollected {
      if (input.protocol > agentConnectorProtocols.newest) {
        throw new AuthError("connector_too_new");
      }
      if (input.protocol < agentConnectorProtocols.oldest) {
        throw new AuthError("connector_too_old");
      }
      limiter.attempt(address);
      const collected = db.transaction(
        (): AgentTokenCollected | "wrong" | "unusable" => {
          settle();
          const setup = db
            .select()
            .from(setups)
            .where(eq(setups.id, input.setupId))
            .get();
          if (!setup) return "unusable";
          if (setup.secretHash !== hashToken(input.secret)) {
            const wrongSecrets = setup.wrongSecrets + 1;
            db.update(setups)
              .set({
                wrongSecrets,
                ...(wrongSecrets >= wrongSecretsPerSetup &&
                  !setup.failedAt && { failedAt: now() }),
              })
              .where(eq(setups.id, setup.id))
              .run();
            return "wrong";
          }
          if (
            setup.clientId ||
            setup.cancelledAt ||
            setup.failedAt ||
            setup.expiresAt.getTime() <= now().getTime()
          ) {
            return "unusable";
          }
          const addedBy: AddedBy = {
            kind: setup.addedByKind,
            id: setup.addedById,
          };
          let made: ReturnType<Clients["createAgent"]>;
          try {
            made = clients.createAgent({
              name: setup.name,
              platform: input.platform,
              addedBy,
            });
          } catch (error) {
            // Whoever started it has left, or their device was signed out.
            if (error instanceof AuthError) return "unusable";
            throw error;
          }
          db.update(setups)
            .set({ clientId: made.client.id, collectedFrom: address })
            .where(eq(setups.id, setup.id))
            .run();
          record({
            action: "agents.add",
            outcome: "ok",
            ...(addedBy.kind === "person"
              ? { personId: addedBy.id }
              : { clientId: addedBy.id }),
            subjectId: made.client.id,
            address,
            detail: { kind: "agent", name: made.client.name },
          });
          return {
            token: made.token,
            agent: { id: made.client.id, name: made.client.name },
          };
        },
      );
      if (collected === "wrong") {
        // Outside the transaction, which would take the entry back with it.
        record({
          action: "agents.add",
          outcome: "refused",
          reason: "wrong_secret",
          address,
        });
      }
      if (typeof collected === "string") throw new AuthError("expired");
      limiter.succeeded(address);
      return collected;
    },

    // Drops every setup after a restore from a backup, whose agents are
    // signed out with every other client.
    dropAll() {
      db.delete(setups).run();
    },

    // Before the agents are listed, so an agent whose setup ran out isn't.
    settle: () => db.transaction(() => settle()),
  };
}

export type AgentSetups = ReturnType<typeof createAgentSetups>;
