import {
  inviteChooseMs,
  inviteConfirmation,
  inviteIdentifier,
  inviteMs,
  inviteTries,
  isUsername,
  normaliseUsername,
  pairingCodeAlphabet,
  pairingLookupLength,
  verifyInviteCheckBinding,
  verifyInviteFinishBinding,
  type CancelInvite,
  type HostView,
  type InviteFinish,
  type InviteInfo,
  type InviteStart,
  type InviteStarted,
  type RedeemCheck,
  type RedeemChecked,
  type RedeemFinish,
  type RedeemRegister,
  type RedeemRegistered,
  type RedeemStart,
  type RedeemStarted,
  type SignedIn,
} from "@meetsanctum/auth-protocol";
import { eq } from "drizzle-orm";
import { randomInt, randomUUID } from "node:crypto";

import type { RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import type { People } from "../people/people.js";
import { clientInfo, type Clients, type Principal } from "./clients.js";
import { AuthError } from "./errors.js";
import {
  createPendingStore,
  defaultLimits,
  type Limiter,
  type Limits,
} from "./limits.js";
import { personInfo } from "./logins.js";
import { createOpaqueServer } from "./opaque-server.js";
import { authInvites, authLogins } from "./schema.js";

// Inviting a person to sign in, and resetting a forgotten password, through
// a one-time code (invites.ts in auth-protocol). Whoever invites registers
// the code's secret from their own device; the person proves it from theirs
// with OPAQUE, which checks the home as signing in does, then registers a
// password of their own there. The host sees neither.

type Making = {
  kind: "make";
  address: string;
  clientId: string;
  personId: string;
  inviteId: string;
  lookup: string;
};

type Redeeming = {
  kind: "redeem";
  address: string;
  // None for a lookup no invite has, which got a made-up response.
  inviteId: string | null;
  record: string | null;
  serverLoginState: string;
};

// A code that checked, while its person chooses a username and password.
type Choosing = {
  address: string;
  inviteId: string;
  personId: string;
  record: string;
  sessionKey: string;
  // The username whose registration was answered last.
  username?: string;
};

type Invite = typeof authInvites.$inferSelect;

const lookupCharacters = [...pairingCodeAlphabet];
const lookups = lookupCharacters.flatMap((first) =>
  lookupCharacters.map((second) => first + second),
);

export function createInvites(
  db: CoreDatabase,
  options: {
    serverSetup: string;
    people: People;
    clients: Clients;
    limiter: Limiter;
    limits?: Limits;
    record: RecordActivity;
    host: () => HostView;
    now: () => Date;
  },
) {
  const { people, clients, limiter, record, host, now } = options;
  const server = createOpaqueServer(options.serverSetup, limiter);
  const limits = options.limits ?? defaultLimits;
  const pending = createPendingStore<Making | Redeeming>({
    limits,
    now: () => now().getTime(),
  });
  // Choosing a username and password takes longer than a sign-in's minute.
  const choosing = createPendingStore<Choosing>({
    limits: { ...limits, openMs: inviteChooseMs },
    now: () => now().getTime(),
  });

  function take<K extends (Making | Redeeming)["kind"]>(
    kind: K,
    id: string,
    address: string,
  ) {
    const entry = pending.take(id, address);
    return entry?.kind === kind
      ? (entry as Extract<Making | Redeeming, { kind: K }>)
      : undefined;
  }

  function inviteOf(personId: string) {
    return db
      .select()
      .from(authInvites)
      .where(eq(authInvites.personId, personId))
      .get();
  }

  function inviteById(id: string) {
    return db.select().from(authInvites).where(eq(authInvites.id, id)).get();
  }

  function loginOf(personId: string) {
    return db
      .select()
      .from(authLogins)
      .where(eq(authLogins.personId, personId))
      .get();
  }

  // Why an invite ended, or none while its code still works.
  function endingOf(invite: Invite): InviteInfo["ended"] {
    if (invite.endedReason) return invite.endedReason;
    return invite.expiresAt <= now() ? "expired" : null;
  }

  function info(invite: Invite): InviteInfo {
    return {
      personId: invite.personId,
      kind: invite.kind,
      createdAt: invite.createdAt.toISOString(),
      endsAt: invite.expiresAt.toISOString(),
      ended: endingOf(invite),
    };
  }

  function username(value: string) {
    const normalised = normaliseUsername(value);
    if (!isUsername(normalised)) {
      throw new AuthError("invalid_request");
    }
    return normalised;
  }

  function usernameHolder(name: string) {
    return db
      .select({ personId: authLogins.personId })
      .from(authLogins)
      .where(eq(authLogins.username, name))
      .get();
  }

  // Ends an invite whose code was tried too often, for its page to say so.
  function endForTries(invite: Invite, address: string) {
    db.update(authInvites)
      .set({ endedReason: "wrong_code", endedAt: now() })
      .where(eq(authInvites.id, invite.id))
      .run();
    record({
      action: "invite.redeem",
      outcome: "refused",
      reason: "too_many_attempts",
      subjectId: invite.personId,
      address,
    });
  }

  return {
    // Every person's invite, for People in Settings.
    list(): InviteInfo[] {
      return db.select().from(authInvites).all().map(info);
    },

    // Any client invites a person, or resets their password, and registers
    // the code's secret its device drew. The lookup comes back with the
    // registration, so the device can show the whole code.
    start(
      principal: Principal,
      address: string,
      input: InviteStart,
    ): InviteStarted {
      if (!people.get(input.personId)) {
        throw new AuthError("not_found");
      }
      const inviteId = randomUUID();
      // A lookup no invite holds, ended ones included, since those keep
      // theirs to tell a late code it ended.
      const held = new Set(
        db
          .select({ lookup: authInvites.lookup })
          .from(authInvites)
          .all()
          .map(({ lookup }) => lookup),
      );
      const free = lookups.filter((lookup) => !held.has(lookup));
      if (free.length === 0) {
        throw new AuthError("busy");
      }
      const lookup = free[randomInt(free.length)]!;
      const registrationResponse = server.registrationResponse(
        inviteIdentifier(inviteId),
        input.registrationRequest,
      );
      const registrationId = pending.add({
        kind: "make",
        address,
        clientId: principal.client.id,
        personId: input.personId,
        inviteId,
        lookup,
      });
      return { registrationId, registrationResponse, lookup };
    },

    // Saves the invite, which replaces the person's last one.
    finish(
      principal: Principal,
      address: string,
      input: InviteFinish,
    ): InviteInfo {
      const entry = take("make", input.registrationId, address);
      if (!entry || entry.clientId !== principal.client.id) {
        throw new AuthError("expired");
      }
      const made = db.transaction(() => {
        if (!people.get(entry.personId)) {
          throw new AuthError("not_found");
        }
        const holder = db
          .select({ personId: authInvites.personId })
          .from(authInvites)
          .where(eq(authInvites.lookup, entry.lookup))
          .get();
        if (holder && holder.personId !== entry.personId) {
          // Another invite took the lookup meanwhile: the device draws a
          // new code.
          throw new AuthError("expired");
        }
        const at = now();
        const kind = loginOf(entry.personId) ? "reset" : "invite";
        db.delete(authInvites)
          .where(eq(authInvites.personId, entry.personId))
          .run();
        const invite = db
          .insert(authInvites)
          .values({
            id: entry.inviteId,
            personId: entry.personId,
            kind,
            lookup: entry.lookup,
            registrationRecord: input.registrationRecord,
            keyStretching: input.keyStretching,
            createdAt: at,
            expiresAt: new Date(at.getTime() + inviteMs),
          })
          .returning()
          .get();
        record({
          action: "invite.create",
          outcome: "ok",
          reason: kind === "reset" ? "reset" : undefined,
          personId: principal.person?.id,
          clientId: principal.client.id,
          subjectId: entry.personId,
        });
        return invite;
      });
      choosing.drop((choice) => choice.personId === entry.personId);
      return info(made);
    },

    // Ends a person's invite before it runs out.
    cancel(principal: Principal, input: CancelInvite) {
      const invite = inviteOf(input.personId);
      if (!invite || endingOf(invite)) {
        throw new AuthError("not_found");
      }
      db.update(authInvites)
        .set({ endedReason: "cancelled", endedAt: now() })
        .where(eq(authInvites.id, invite.id))
        .run();
      record({
        action: "invite.cancel",
        outcome: "ok",
        personId: principal.person?.id,
        clientId: principal.client.id,
        subjectId: input.personId,
      });
      choosing.drop((choice) => choice.inviteId === invite.id);
    },

    // OPAQUE's first round with the code's secret. Every try at a working
    // invite counts, since a wrong code fails on the device and the host
    // never hears of it; past the limit the invite ends. A lookup no invite
    // has gets a made-up response that looks like a real one.
    redeemStart(address: string, input: RedeemStart): RedeemStarted {
      host();
      const lookup = input.lookup.toUpperCase();
      if (
        lookup.length !== pairingLookupLength ||
        ![...lookup].every((char) => pairingCodeAlphabet.includes(char))
      ) {
        throw new AuthError("invalid_request");
      }
      limiter.attempt(address);
      const invite = db
        .select()
        .from(authInvites)
        .where(eq(authInvites.lookup, lookup))
        .get();
      if (invite && !endingOf(invite)) {
        if (invite.tries + 1 > inviteTries) {
          endForTries(invite, address);
        } else {
          db.update(authInvites)
            .set({ tries: invite.tries + 1 })
            .where(eq(authInvites.id, invite.id))
            .run();
        }
      }
      const { serverLoginState, loginResponse } = server.startLogin(
        inviteIdentifier(invite?.id ?? `lookup:${lookup}`),
        invite?.registrationRecord ?? null,
        input.startLoginRequest,
      );
      const redeemId = pending.add({
        kind: "redeem",
        address,
        inviteId: invite?.id ?? null,
        record: invite?.registrationRecord ?? null,
        serverLoginState,
      });
      return { redeemId, loginResponse };
    },

    // The code was right and the device sees this host: the person sees
    // whose invite it is and chooses a username and password. A right code
    // whose invite ended hears so.
    async redeemCheck(
      address: string,
      input: RedeemCheck,
    ): Promise<RedeemChecked> {
      const view = host();
      const entry = take("redeem", input.redeemId, address);
      const refuse = (
        reason: "sign_in_failed" | "channel_mismatch",
        personId?: string,
      ) => {
        record({
          action: "invite.redeem",
          outcome: "refused",
          reason,
          subjectId: personId,
          address,
        });
        return new AuthError(reason);
      };
      if (!entry) {
        // A made-up, replayed or expired id counts like a sign-in's.
        limiter.attempt(address);
        throw refuse("sign_in_failed");
      }
      const sessionKey = server.finishLogin(
        entry.serverLoginState,
        input.finishLoginRequest,
      );
      if (!sessionKey || !entry.inviteId || !entry.record) {
        throw refuse("sign_in_failed");
      }
      const invite = inviteById(entry.inviteId);
      if (!(await verifyInviteCheckBinding(sessionKey, view, input.binding))) {
        throw refuse("channel_mismatch", invite?.personId);
      }
      // Replaced or used since the start, or ended: the code no longer works.
      if (
        !invite ||
        invite.registrationRecord !== entry.record ||
        endingOf(invite)
      ) {
        throw new AuthError("invite_ended");
      }
      const person = people.get(invite.personId);
      if (!person) {
        throw new AuthError("invite_ended");
      }
      db.update(authInvites)
        .set({ tries: 0 })
        .where(eq(authInvites.id, invite.id))
        .run();
      const redeemId = choosing.add({
        address,
        inviteId: invite.id,
        personId: invite.personId,
        record: invite.registrationRecord,
        sessionKey,
      });
      limiter.succeeded(address);
      return {
        redeemId,
        person: personInfo(person),
        username: loginOf(invite.personId)?.username ?? null,
      };
    },

    // Answers the registration of the password the person chose, under the
    // username they chose. A taken username can be changed and sent again.
    redeemRegister(address: string, input: RedeemRegister): RedeemRegistered {
      const entry = choosing.peek(input.redeemId, address);
      if (!entry) {
        throw new AuthError("expired");
      }
      const name = username(input.username);
      const holder = usernameHolder(name);
      if (holder && holder.personId !== entry.personId) {
        throw new AuthError("username_taken");
      }
      const registrationResponse = server.registrationResponse(
        name,
        input.registrationRequest,
      );
      entry.username = name;
      return { registrationResponse };
    },

    // Saves the person's sign-in, ends the invite and creates this device's
    // personal client, all at once; then the host confirms the token.
    async redeemFinish(
      address: string,
      input: RedeemFinish,
    ): Promise<SignedIn> {
      const view = host();
      const entry = choosing.take(input.redeemId, address);
      if (!entry?.username) {
        throw new AuthError("expired");
      }
      const name = entry.username;
      const bound = await verifyInviteFinishBinding(
        entry.sessionKey,
        view,
        name,
        input.registrationRecord,
        input.binding,
      );
      if (!bound) {
        record({
          action: "invite.redeem",
          outcome: "refused",
          reason: "channel_mismatch",
          subjectId: entry.personId,
          address,
        });
        throw new AuthError("channel_mismatch");
      }
      const done = db.transaction(() => {
        const invite = inviteById(entry.inviteId);
        if (
          !invite ||
          invite.registrationRecord !== entry.record ||
          endingOf(invite)
        ) {
          throw new AuthError("invite_ended");
        }
        const person = people.get(invite.personId);
        if (!person) {
          throw new AuthError("invite_ended");
        }
        const holder = usernameHolder(name);
        if (holder && holder.personId !== invite.personId) {
          throw new AuthError("username_taken");
        }
        const values = {
          username: name,
          registrationRecord: input.registrationRecord,
          keyStretching: input.keyStretching,
          updatedAt: now(),
        };
        db.insert(authLogins)
          .values({ personId: invite.personId, ...values })
          .onConflictDoUpdate({ target: authLogins.personId, set: values })
          .run();
        db.delete(authInvites).where(eq(authInvites.id, invite.id)).run();
        const { client, token } = clients.createPersonal({
          ...input.client,
          personId: invite.personId,
        });
        record({
          action: "invite.redeem",
          outcome: "ok",
          reason: invite.kind === "reset" ? "reset" : undefined,
          personId: invite.personId,
          clientId: client.id,
          address,
        });
        return { person, client, token };
      });
      return {
        token: done.token,
        confirmation: await inviteConfirmation(
          entry.sessionKey,
          view,
          done.token,
        ),
        client: clientInfo(done.client, done.client.id),
        person: personInfo(done.person),
      };
    },
  };
}

export type Invites = ReturnType<typeof createInvites>;
