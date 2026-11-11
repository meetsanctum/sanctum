import * as opaque from "@serenity-kit/opaque";

import { createActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import type { People } from "../people/people.js";
import { createClients } from "./clients.js";
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

  return {
    isClaimed: () => isClaimed(db),
    // Signs every device out after a restore from a backup: every client and
    // token is revoked and every pairing request dropped, inside the
    // restore's transaction. Returns how many clients it signed out.
    signOutEveryone(at: Date) {
      const count = clients.revokeAll(at);
      pairing.dropAll();
      return count;
    },
    authenticate: clients.authenticate,
    clients,
    logins,
    pairing,
    connections,
  };
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
