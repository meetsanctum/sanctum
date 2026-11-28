import {
  inviteChooseMs,
  inviteConfirmation,
  inviteIdentifier,
  inviteMs,
  inviteTries,
  isUsername,
  keyStretching,
  newInviteSecret,
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
  type RedeemFinished,
  type RedeemRegister,
  type RedeemRegistered,
  type RedeemStart,
  type RedeemStarted,
} from "@meetsanctum/auth-protocol";
import * as opaque from "@serenity-kit/opaque";
import { and, eq, ne } from "drizzle-orm";
import { randomInt, randomUUID } from "node:crypto";

import type { RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import type { People } from "../people/people.js";
import { personalCaller } from "./callers.js";
import { clientInfo, type Clients, type Principal } from "./clients.js";
import { codeLookups } from "./code-lookups.js";
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
// a one-time code (invites.ts in auth-protocol). A code made on a client
// registers its secret without revealing it to the host. The person proves
// the secret with OPAQUE, which checks the home as signing in does, then
// registers a password of their own. The password stays on their device.

type Making = {
  kind: "make";
  address: string;
  clientId: string;
  personId: string;
  inviteKind: InviteInfo["kind"];
  replacesInviteId?: string;
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

// A code made on the host itself, for someone with no other way back in,
// works for an hour.
const hostCodeMs = 60 * 60_000;

// A recovery code has no end of its own: it lasts until it's used or
// replaced. Its row still has a date, far enough away never to arrive.
const recoveryMs = 100 * 365 * 24 * 60 * 60_000;

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

  // A person's invite or reset; their recovery code stands beside it.
  function inviteOf(personId: string) {
    return db
      .select()
      .from(authInvites)
      .where(
        and(
          eq(authInvites.personId, personId),
          ne(authInvites.kind, "recovery"),
        ),
      )
      .get();
  }

  function recoveryOf(personId: string) {
    return db
      .select()
      .from(authInvites)
      .where(
        and(
          eq(authInvites.personId, personId),
          eq(authInvites.kind, "recovery"),
        ),
      )
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

  // Why an invite ended, or none while it is active.
  function endingOf(invite: Invite): InviteInfo["ended"] {
    if (invite.endedReason) return invite.endedReason;
    return invite.expiresAt <= now() ? "expired" : null;
  }

  function info(invite: Invite): InviteInfo {
    return {
      id: invite.id,
      personId: invite.personId,
      kind: invite.kind,
      createdAt: invite.createdAt.toISOString(),
      endsAt: invite.expiresAt.toISOString(),
      ended: endingOf(invite),
    };
  }

  function checkMake(
    principal: Principal,
    personId: string,
    kind: InviteInfo["kind"],
    replacesInviteId: string | undefined,
  ) {
    if (!people.get(personId)) {
      throw new AuthError("not_found");
    }
    // A recovery code is made by its own person, on their own device.
    if (kind === "recovery") {
      if (personalCaller(principal) !== personId) {
        throw new AuthError("forbidden");
      }
      if (!loginOf(personId)) {
        throw new AuthError("invite_kind_changed");
      }
      const current = recoveryOf(personId);
      const activeId = current && !endingOf(current) ? current.id : undefined;
      if (activeId !== replacesInviteId) {
        throw new AuthError("invite_changed");
      }
      return current;
    }
    if ((kind === "reset") !== Boolean(loginOf(personId))) {
      throw new AuthError("invite_kind_changed");
    }
    const current = inviteOf(personId);
    if (current && !endingOf(current) && current.id !== replacesInviteId) {
      throw new AuthError("invite_changed");
    }
    return current;
  }

  // A lookup no invite holds, ended ones included, since those keep theirs
  // to tell a late code it ended.
  function freeLookup() {
    const held = new Set(
      db
        .select({ lookup: authInvites.lookup })
        .from(authInvites)
        .all()
        .map(({ lookup }) => lookup),
    );
    const free = codeLookups.filter((lookup) => !held.has(lookup));
    if (free.length === 0) {
      throw new AuthError("busy");
    }
    return free[randomInt(free.length)]!;
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

  function recordAttempt(
    invite: Invite,
    tries: number,
    at: Date,
    address: string,
  ) {
    // After the first refusal, further requests cannot extend the cooldown.
    if (tries > inviteTries) return;
    const blocked = tries === inviteTries;
    db.update(authInvites)
      .set({ tries: tries + 1, lastTriedAt: blocked ? invite.lastTriedAt : at })
      .where(eq(authInvites.id, invite.id))
      .run();
    if (blocked) {
      record({
        action: "invite.redeem",
        outcome: "refused",
        reason: "too_many_attempts",
        subjectId: invite.personId,
        address,
      });
    }
  }

  return {
    // Lists active and ended invites with their status. A recovery code is
    // listed only to its own person's devices.
    list(principal: Principal): InviteInfo[] {
      const own =
        principal.client.kind === "personal" ? principal.person?.id : undefined;
      return db
        .select()
        .from(authInvites)
        .all()
        .filter(
          (invite) => invite.kind !== "recovery" || invite.personId === own,
        )
        .map(info);
    },

    // Who signs in, by name and username, for the command on the host.
    signIns() {
      return db
        .select()
        .from(authLogins)
        .all()
        .flatMap((login) => {
          const person = people.get(login.personId);
          return person
            ? [{ name: person.name, username: login.username }]
            : [];
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    // A code for a new password, made on the host itself for someone with
    // no other way back in: by a command run there, which only someone who
    // can run commands on the host can do. Unlike every other code, the host
    // draws its secret, and so sees it; it never sees a password. It is a
    // reset that works once, for an hour. Replacing an active invite or reset
    // requires consent; the person's recovery code stays.
    async makeOnHost(name: string, replace = false) {
      await opaque.ready;
      const holder = usernameHolder(username(name));
      const person = holder && people.get(holder.personId);
      if (!holder || !person) {
        throw new AuthError("not_found");
      }
      const current = inviteOf(person.id);
      if (current && !endingOf(current) && !replace) {
        throw new AuthError("invite_changed");
      }
      const inviteId = randomUUID();
      const secret = newInviteSecret();
      const { clientRegistrationState, registrationRequest } =
        opaque.client.startRegistration({ password: secret });
      const { registrationRecord } = opaque.client.finishRegistration({
        clientRegistrationState,
        registrationResponse: server.registrationResponse(
          inviteIdentifier(inviteId),
          registrationRequest,
        ),
        password: secret,
        keyStretching: keyStretching.profile,
      });
      const replaced = current?.id;
      const made = db.transaction(() => {
        const lookup = freeLookup();
        const at = now();
        if (replaced) {
          db.delete(authInvites).where(eq(authInvites.id, replaced)).run();
        }
        const invite = db
          .insert(authInvites)
          .values({
            id: inviteId,
            personId: person.id,
            kind: "reset",
            lookup,
            registrationRecord,
            keyStretching: keyStretching.version,
            createdAt: at,
            expiresAt: new Date(at.getTime() + hostCodeMs),
          })
          .returning()
          .get();
        record({
          action: "invite.create",
          outcome: "ok",
          reason: "reset",
          actor: "sanctum",
          subjectId: person.id,
        });
        return invite;
      });
      choosing.drop((choice) => choice.inviteId === replaced);
      return {
        code: `${made.lookup}${secret}`,
        name: person.name,
        endsAt: made.expiresAt.toISOString(),
      };
    },

    // Restoring a backup must not bring back previously issued codes.
    dropAll() {
      db.delete(authInvites).run();
      pending.drop(() => true);
      choosing.drop(() => true);
    },

    // Any client invites a person, or resets their password, and registers
    // the code's secret its device drew. The lookup comes back with the
    // registration, so the device can show the whole code.
    start(
      principal: Principal,
      address: string,
      input: InviteStart,
    ): InviteStarted {
      checkMake(principal, input.personId, input.kind, input.replacesInviteId);
      const inviteId = randomUUID();
      const lookup = freeLookup();
      const registrationResponse = server.registrationResponse(
        inviteIdentifier(inviteId),
        input.registrationRequest,
      );
      const registrationId = pending.add({
        kind: "make",
        address,
        clientId: principal.client.id,
        personId: input.personId,
        inviteKind: input.kind,
        replacesInviteId: input.replacesInviteId,
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
      let replaced: string | undefined;
      const made = db.transaction(() => {
        const kind = entry.inviteKind;
        replaced = checkMake(
          principal,
          entry.personId,
          kind,
          entry.replacesInviteId,
        )?.id;
        const holder = db
          .select({ id: authInvites.id })
          .from(authInvites)
          .where(eq(authInvites.lookup, entry.lookup))
          .get();
        if (holder && holder.id !== replaced) {
          // Another invite took the lookup meanwhile: the device draws a
          // new code.
          throw new AuthError("expired");
        }
        const at = now();
        // An invite or reset replaces the last one; a recovery code, the
        // last recovery code.
        if (replaced) {
          db.delete(authInvites).where(eq(authInvites.id, replaced)).run();
        }
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
            expiresAt: new Date(
              at.getTime() + (kind === "recovery" ? recoveryMs : inviteMs),
            ),
          })
          .returning()
          .get();
        record({
          action: "invite.create",
          outcome: "ok",
          reason: kind === "invite" ? undefined : kind,
          personId: principal.person?.id,
          clientId: principal.client.id,
          subjectId: entry.personId,
        });
        return invite;
      });
      choosing.drop((choice) => choice.inviteId === replaced);
      return info(made);
    },

    // Ends a person's invite before it runs out.
    cancel(principal: Principal, input: CancelInvite) {
      const invite = inviteOf(input.personId);
      if (!invite || endingOf(invite)) {
        throw new AuthError("not_found");
      }
      if (invite.id !== input.inviteId) {
        throw new AuthError("invite_changed");
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

    // Wrong codes fail on the device, so each issued challenge counts.
    // Lookups on cooldown get the same response as unknown lookups.
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
      const found = db
        .select()
        .from(authInvites)
        .where(eq(authInvites.lookup, lookup))
        .get();
      const at = now();
      const active = found !== undefined && !endingOf(found);
      const tries =
        found?.lastTriedAt &&
        at.getTime() - found.lastTriedAt.getTime() < limits.attemptWindowMs
          ? found.tries
          : 0;
      const invite = active && tries >= inviteTries ? undefined : found;
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
      if (active) {
        recordAttempt(found, tries, at, address);
      }
      return {
        redeemId,
        loginResponse,
        keyStretching: invite?.keyStretching ?? keyStretching.version,
      };
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
      if (!(await verifyInviteCheckBinding(sessionKey, view, input.binding))) {
        throw refuse("channel_mismatch", inviteById(entry.inviteId)?.personId);
      }
      // Replaced or used since the start, or ended: the code no longer works.
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
      const redeemId = choosing.add({
        address,
        inviteId: invite.id,
        personId: invite.personId,
        record: invite.registrationRecord,
        sessionKey,
      });
      db.update(authInvites)
        .set({ tries: 0, lastTriedAt: null })
        .where(eq(authInvites.id, invite.id))
        .run();
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
      return { registrationResponse, username: name };
    },

    // Saves the person's sign-in, ends the invite and creates this device's
    // personal client, all at once; then the host confirms the token.
    async redeemFinish(
      address: string,
      input: RedeemFinish,
    ): Promise<RedeemFinished> {
      const view = host();
      const entry = choosing.peek(input.redeemId, address);
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
      // It may have been used, cancelled or registered with another name
      // while the binding was verified.
      if (
        choosing.peek(input.redeemId, address) !== entry ||
        entry.username !== name
      ) {
        throw new AuthError("expired");
      }
      if (!bound) {
        choosing.take(input.redeemId, address);
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
        const person = invite && people.get(invite.personId);
        if (
          !invite ||
          !person ||
          invite.registrationRecord !== entry.record ||
          endingOf(invite) ||
          (invite.kind !== "invite") !== Boolean(loginOf(entry.personId))
        ) {
          choosing.take(input.redeemId, address);
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
        if (invite.kind === "recovery") {
          // An earlier reset must not replace the password chosen here.
          const reset = inviteOf(invite.personId);
          if (reset?.kind === "reset" && !endingOf(reset)) {
            db.update(authInvites)
              .set({ endedReason: "cancelled", endedAt: values.updatedAt })
              .where(eq(authInvites.id, reset.id))
              .run();
          }
        }
        const { client, token } = clients.createPersonal({
          ...input.client,
          personId: invite.personId,
        });
        record({
          action: "invite.redeem",
          outcome: "ok",
          reason: invite.kind === "invite" ? undefined : invite.kind,
          personId: invite.personId,
          clientId: client.id,
          address,
        });
        return { person, client, token };
      });
      choosing.take(input.redeemId, address);
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
