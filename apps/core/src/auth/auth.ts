import type { AgentInfo } from "@meetsanctum/auth-protocol";
import * as opaque from "@serenity-kit/opaque";

import { createActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import type { People } from "../people/people.js";
import { createAgentSetups } from "./agent-setups.js";
import { createClients, type AddedBy } from "./clients.js";
import { createLimiter, type Limits } from "./limits.js";
import { createConnections } from "./live.js";
import {
  countLogins,
  createLogins,
  isClaimed,
  loadServerSetup,
} from "./logins.js";
import { createPairing } from "./pairing.js";

// Auth: the module of the core that turns each request's credential into a
// principal. Its calls are plain routes (routes.ts), not core actions.

// What People needs from Auth for its login rule: a claimed host always
// keeps someone who can sign in.
export function loginRule(db: CoreDatabase) {
  return {
    isClaimed: () => isClaimed(db),
    countLogins: () => countLogins(db),
  };
}

export async function createAuth(
  db: CoreDatabase,
  options: {
    people: People;
    // The host's id, which the manager keeps, once it has answered.
    hostId: () => string | undefined;
    // The home's id, which the core's database keeps.
    homeId: string;
    // The host CA's pin, which sign-ins are bound to; none over plain HTTP.
    pin?: () => string | null;
    // Called once the claim has committed, to tell the manager.
    onClaimed?: () => void;
    limits?: Limits;
    now?: () => Date;
  },
) {
  await opaque.ready;
  const now = options.now ?? (() => new Date());
  const record = createActivity(db, { now }).for("auth");
  const connections = createConnections({ now });
  const limiter = createLimiter({
    limits: options.limits,
    now: () => now().getTime(),
    onLimitReached: (address) =>
      record({
        action: "sign-in",
        outcome: "refused",
        reason: "too_many_attempts",
        address,
      }),
  });
  const clients = createClients(db, {
    record,
    connections,
    now,
  });
  const logins = createLogins(db, {
    serverSetup: loadServerSetup(db, now),
    people: options.people,
    clients,
    limiter,
    limits: options.limits,
    record,
    hostId: options.hostId,
    homeId: options.homeId,
    pin: options.pin ?? (() => null),
    onClaimed: () => options.onClaimed?.(),
    now,
  });
  const pairing = createPairing(db, {
    clients,
    record,
    limits: options.limits,
    now,
  });
  const agentSetups = createAgentSetups(db, {
    clients,
    record,
    // Wrong secrets have a counter of their own, so a computer that sends
    // them doesn't stop its household signing in.
    limiter: createLimiter({
      limits: options.limits,
      now: () => now().getTime(),
      onLimitReached: (address) =>
        record({
          action: "agents.add",
          outcome: "refused",
          reason: "too_many_attempts",
          address,
        }),
    }),
    homeId: options.homeId,
    pin: options.pin ?? (() => null),
    limits: options.limits,
    now,
  });

  // The adder's name as it stands now, for the activity log and Settings.
  function namedAdder(addedBy: AddedBy) {
    const name =
      addedBy.kind === "person"
        ? (options.people.get(addedBy.id)?.name ?? null)
        : clients.name(addedBy.id);
    return { ...addedBy, name };
  }

  return {
    isClaimed: () => isClaimed(db),
    /** A person or a shared device, by their name now. */
    named: namedAdder,
    agentAdder(id: string) {
      const addedBy = clients.addedBy(id);
      return addedBy ? namedAdder(addedBy) : null;
    },
    // The home's AI agents, for Settings.
    agents(): AgentInfo[] {
      agentSetups.settle();
      return clients.listAgents().map((agent) => ({
        id: agent.id,
        name: agent.name,
        platform: agent.platform,
        addedBy: namedAdder(agent.addedBy),
        createdAt: agent.createdAt.toISOString(),
        lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
      }));
    },
    // Signs every device out after a restore from a backup: every client and
    // token is revoked and every pairing request dropped, inside the
    // restore's transaction. Returns how many devices it signed out.
    signOutEveryone(at: Date) {
      const count = clients.revokeAll(at);
      pairing.dropAll();
      agentSetups.dropAll();
      return count;
    },
    authenticate: clients.authenticate,
    clients,
    logins,
    pairing,
    agentSetups,
    connections,
  };
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
