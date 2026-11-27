import {
  isUsername,
  normaliseUsername,
  signInConfirmation,
  verifyPasswordChangeBinding,
  verifySignInBinding,
  type ClaimFinish,
  type ClaimStart,
  type HostStatus,
  type HostView,
  type LoginInfo,
  type PasswordChooseFinish,
  type PasswordChooseStart,
  type PasswordFinish,
  type PasswordStart,
  type PasswordStarted,
  type PersonInfo,
  type RegistrationStarted,
  type RemoveLogin,
  type SetLoginFinish,
  type SetLoginStart,
  type SignedIn,
  type SignInFinish,
  type SignInStart,
  type SignInStarted,
} from "@meetsanctum/auth-protocol";
import * as opaque from "@serenity-kit/opaque";
import { and, asc, count, eq, gt, isNotNull, isNull } from "drizzle-orm";

import type { RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import type { People, Person } from "../people/people.js";
import { personalCaller } from "./callers.js";
import { clientInfo, type Clients, type Principal } from "./clients.js";
import { AuthError } from "./errors.js";
import { createPendingStore, type Limiter, type Limits } from "./limits.js";
import { createOpaqueServer } from "./opaque-server.js";
import { authInvites, authLogins, authServer } from "./schema.js";

// Claiming the host, logins and signing in, all through OPAQUE: devices
// register and check passwords, and the host never sees one.

type Pending =
  | { kind: "claim"; address: string; username: string }
  | {
      kind: "sign-in";
      address: string;
      username: string;
      // None for an unknown username, which got a fake response.
      personId: string | null;
      record: string | null;
      serverLoginState: string;
    }
  | {
      kind: "set-login";
      address: string;
      clientId: string;
      personId: string;
      username: string;
    }
  | {
      kind: "password";
      address: string;
      clientId: string;
      personId: string;
      username: string;
      record: string;
      serverLoginState: string;
    }
  | {
      kind: "choose";
      address: string;
      clientId: string;
      personId: string;
      username: string;
      record: string;
    };

export function personInfo(person: Person): PersonInfo {
  const { id, name, avatar, colour } = person;
  return { id, name, avatar, colour };
}

export function isClaimed(db: CoreDatabase) {
  return !!db
    .select({ id: authServer.id })
    .from(authServer)
    .where(and(eq(authServer.id, 1), isNotNull(authServer.claimedAt)))
    .get();
}

// The people who can still sign in. Reads through the same connection, so
// inside a transaction it sees the change.
export function countLogins(db: CoreDatabase) {
  return db.select({ count: count() }).from(authLogins).get()?.count ?? 0;
}

// The host's OPAQUE server setup, created on first start. It must never be
// replaced: every registration record depends on it.
export function loadServerSetup(db: CoreDatabase, now: () => Date) {
  const existing = db
    .select({ serverSetup: authServer.serverSetup })
    .from(authServer)
    .where(eq(authServer.id, 1))
    .get();
  if (existing) {
    return existing.serverSetup;
  }
  const serverSetup = opaque.server.createSetup();
  db.insert(authServer)
    .values({ id: 1, serverSetup, createdAt: now() })
    .onConflictDoNothing()
    .run();
  return db
    .select({ serverSetup: authServer.serverSetup })
    .from(authServer)
    .where(eq(authServer.id, 1))
    .get()!.serverSetup;
}

export function createLogins(
  db: CoreDatabase,
  options: {
    serverSetup: string;
    people: People;
    clients: Clients;
    limiter: Limiter;
    limits?: Limits;
    record: RecordActivity;
    hostId: () => string | undefined;
    // The home's id, which this database keeps.
    homeId: string;
    // The pin of the host CA the core serves; none over plain HTTP, where
    // bindings cover the ids alone.
    pin: () => string | null;
    onClaimed: () => void;
    now: () => Date;
  },
) {
  const { serverSetup, people, clients, limiter, record, now } = options;
  const server = createOpaqueServer(serverSetup, limiter);
  const pending = createPendingStore<Pending>({
    limits: options.limits,
    now: () => now().getTime(),
  });

  function host(): HostView {
    const hostId = options.hostId();
    if (!hostId) {
      throw new AuthError("host_starting");
    }
    return { hostId, homeId: options.homeId, pin: options.pin() };
  }

  function username(value: string) {
    const normalised = normaliseUsername(value);
    if (!isUsername(normalised)) {
      throw new AuthError("invalid_request");
    }
    return normalised;
  }

  function loginByUsername(name: string) {
    return db
      .select()
      .from(authLogins)
      .where(eq(authLogins.username, name))
      .get();
  }

  function loginOf(personId: string) {
    return db
      .select()
      .from(authLogins)
      .where(eq(authLogins.personId, personId))
      .get();
  }

  const personal = personalCaller;

  const registrationResponse = server.registrationResponse;
  const startLogin = server.startLogin;
  const finishLogin = server.finishLogin;

  function take<K extends Pending["kind"]>(
    kind: K,
    id: string,
    address: string,
  ) {
    const entry = pending.take(id, address);
    return entry?.kind === kind
      ? (entry as Extract<Pending, { kind: K }>)
      : undefined;
  }

  return {
    // The host as a device that signs in or pairs must see it.
    host,
    status(): HostStatus {
      const { hostId, homeId } = host();
      return { hostId, homeId, claimed: isClaimed(db) };
    },

    // Anyone on the home network may claim an unclaimed host, once.
    claimStart(address: string, input: ClaimStart): RegistrationStarted {
      if (isClaimed(db)) {
        throw new AuthError("claimed");
      }
      const name = username(input.username);
      limiter.attempt(address);
      const response = registrationResponse(name, input.registrationRequest);
      const registrationId = pending.add({
        kind: "claim",
        address,
        username: name,
      });
      return { registrationId, registrationResponse: response };
    },

    // Creates the first person, their login and a personal
    // client in one transaction, which also sets the claimed flag.
    claimFinish(address: string, input: ClaimFinish): SignedIn {
      const entry = take("claim", input.registrationId, address);
      if (!entry) {
        throw new AuthError("expired");
      }
      const claimed = db.transaction(() => {
        if (isClaimed(db)) {
          throw new AuthError("claimed");
        }
        const at = now();
        const person = people.add(input.person);
        db.insert(authLogins)
          .values({
            personId: person.id,
            username: entry.username,
            registrationRecord: input.registrationRecord,
            keyStretching: input.keyStretching,
            updatedAt: at,
          })
          .run();
        const { client, token } = clients.createPersonal({
          ...input.client,
          personId: person.id,
        });
        db.update(authServer)
          .set({ claimedAt: at })
          .where(eq(authServer.id, 1))
          .run();
        record({
          action: "host.claim",
          outcome: "ok",
          personId: person.id,
          clientId: client.id,
          address,
        });
        return { person, client, token };
      });
      limiter.succeeded(address);
      options.onClaimed();
      return {
        token: claimed.token,
        client: clientInfo(claimed.client, claimed.client.id),
        person: personInfo(claimed.person),
      };
    },

    // Starts a sign-in. An unknown username gets a fake response that looks
    // like a real one.
    signInStart(address: string, input: SignInStart): SignInStarted {
      const name = username(input.username);
      host();
      limiter.attempt(address);
      const login = loginByUsername(name);
      const record = login?.registrationRecord ?? null;
      const { serverLoginState, loginResponse } = startLogin(
        name,
        record,
        input.startLoginRequest,
      );
      const signInId = pending.add({
        kind: "sign-in",
        address,
        username: name,
        personId: login?.personId ?? null,
        record,
        serverLoginState,
      });
      return { signInId, loginResponse };
    },

    // Finishes a sign-in: checks OPAQUE's last message and the device's
    // binding, then creates the personal client.
    async signInFinish(
      address: string,
      input: SignInFinish,
    ): Promise<SignedIn> {
      const view = host();
      const entry = take("sign-in", input.signInId, address);
      const refuse = (reason: "sign_in_failed" | "channel_mismatch") => {
        record({
          action: "sign-in",
          outcome: "refused",
          reason,
          personId: entry?.personId,
          address,
        });
        return new AuthError(reason);
      };
      if (!entry) {
        // A made-up, replayed or expired id must not bypass the start
        // limit and write unlimited failed attempts to the activity log.
        limiter.attempt(address);
        throw refuse("sign_in_failed");
      }
      const sessionKey = finishLogin(
        entry.serverLoginState,
        input.finishLoginRequest,
      );
      if (!sessionKey || !entry.personId) {
        throw refuse("sign_in_failed");
      }
      if (!(await verifySignInBinding(sessionKey, view, input.binding))) {
        // The password was right, but the device saw another host: someone
        // is in between. No client is created.
        throw refuse("channel_mismatch");
      }
      const personId = entry.personId;
      const signedIn = db.transaction(() => {
        // A reset or removal since the start invalidates the sign-in.
        const login = loginOf(personId);
        const person = people.get(personId);
        if (!login || !person || login.registrationRecord !== entry.record) {
          return undefined;
        }
        const { client, token } = clients.createPersonal({
          ...input.client,
          personId,
        });
        record({
          action: "sign-in",
          outcome: "ok",
          personId,
          clientId: client.id,
          address,
        });
        return { person, client, token };
      });
      if (!signedIn) {
        throw refuse("sign_in_failed");
      }
      limiter.succeeded(address);
      return {
        token: signedIn.token,
        confirmation: await signInConfirmation(
          sessionKey,
          view,
          signedIn.token,
        ),
        client: clientInfo(signedIn.client, signedIn.client.id),
        person: personInfo(signedIn.person),
      };
    },

    // Any client creates a login or resets its password, and registers the
    // password it was given.
    setLoginStart(
      principal: Principal,
      address: string,
      input: SetLoginStart,
    ): RegistrationStarted {
      if (!people.get(input.personId)) {
        throw new AuthError("not_found");
      }
      const name = username(input.username);
      const holder = loginByUsername(name);
      if (holder && holder.personId !== input.personId) {
        throw new AuthError("username_taken");
      }
      limiter.attempt(address);
      const response = registrationResponse(name, input.registrationRequest);
      const registrationId = pending.add({
        kind: "set-login",
        address,
        clientId: principal.client.id,
        personId: input.personId,
        username: name,
      });
      return { registrationId, registrationResponse: response };
    },

    setLoginFinish(
      principal: Principal,
      address: string,
      input: SetLoginFinish,
    ) {
      const entry = take("set-login", input.registrationId, address);
      if (!entry || entry.clientId !== principal.client.id) {
        throw new AuthError("expired");
      }
      db.transaction(() => {
        if (!people.get(entry.personId)) {
          throw new AuthError("not_found");
        }
        const holder = loginByUsername(entry.username);
        if (holder && holder.personId !== entry.personId) {
          throw new AuthError("username_taken");
        }
        const at = now();
        const values = {
          username: entry.username,
          registrationRecord: input.registrationRecord,
          keyStretching: input.keyStretching,
          updatedAt: at,
        };
        db.insert(authLogins)
          .values({ personId: entry.personId, ...values })
          .onConflictDoUpdate({ target: authLogins.personId, set: values })
          .run();
        db.update(authInvites)
          .set({ endedReason: "cancelled", endedAt: at })
          .where(
            and(
              eq(authInvites.personId, entry.personId),
              eq(authInvites.kind, "invite"),
              isNull(authInvites.endedReason),
              gt(authInvites.expiresAt, at),
            ),
          )
          .run();
        record({
          action: "login.set",
          outcome: "ok",
          personId: principal.person?.id,
          clientId: principal.client.id,
          subjectId: entry.personId,
        });
      });
      limiter.succeeded(address);
    },

    // Who signs in, by username, for Settings → People.
    list(): LoginInfo[] {
      return db
        .select({
          personId: authLogins.personId,
          username: authLogins.username,
        })
        .from(authLogins)
        .orderBy(asc(authLogins.username))
        .all();
    },

    // Refused if it would leave the claimed host without anyone who can
    // sign in. Their personal devices sign out with it: without a sign-in,
    // nothing is left that they sign in again with.
    removeLogin(principal: Principal, input: RemoveLogin) {
      const signedOut = db.transaction(() => {
        const removed = db
          .delete(authLogins)
          .where(eq(authLogins.personId, input.personId))
          .returning()
          .get();
        if (!removed) {
          throw new AuthError("not_found");
        }
        if (isClaimed(db) && countLogins(db) === 0) {
          throw new AuthError("last_login");
        }
        db.delete(authInvites)
          .where(eq(authInvites.personId, input.personId))
          .run();
        record({
          action: "login.remove",
          outcome: "ok",
          personId: principal.person?.id,
          clientId: principal.client.id,
          subjectId: input.personId,
        });
        return clients.revokePersonal(input.personId, now());
      });
      pending.drop(
        (entry) => "personId" in entry && entry.personId === input.personId,
      );
      clients.close(signedOut);
    },

    // Changing your own password proves the current one on the host, bound
    // to this change, and registers the new one. It counts as a sign-in and
    // creates no client.
    passwordStart(
      principal: Principal,
      address: string,
      input: PasswordStart,
    ): PasswordStarted {
      const personId = personal(principal);
      host();
      const login = loginOf(personId);
      if (!login) {
        throw new AuthError("not_found");
      }
      limiter.attempt(address);
      const { serverLoginState, loginResponse } = startLogin(
        login.username,
        login.registrationRecord,
        input.startLoginRequest,
      );
      const response = registrationResponse(
        login.username,
        input.registrationRequest,
      );
      const changeId = pending.add({
        kind: "password",
        address,
        clientId: principal.client.id,
        personId,
        username: login.username,
        record: login.registrationRecord,
        serverLoginState,
      });
      return { changeId, loginResponse, registrationResponse: response };
    },

    async passwordFinish(
      principal: Principal,
      address: string,
      input: PasswordFinish,
    ) {
      const personId = personal(principal);
      const view = host();
      const entry = take("password", input.changeId, address);
      if (!entry || entry.clientId !== principal.client.id) {
        throw new AuthError("expired");
      }
      const refuse = (reason: "sign_in_failed" | "channel_mismatch") => {
        record({
          action: "password.change",
          outcome: "refused",
          reason,
          personId,
          clientId: principal.client.id,
        });
        return new AuthError(reason);
      };
      const sessionKey = finishLogin(
        entry.serverLoginState,
        input.finishLoginRequest,
      );
      if (!sessionKey) {
        throw refuse("sign_in_failed");
      }
      const bound = await verifyPasswordChangeBinding(
        sessionKey,
        view,
        input.registrationRecord,
        input.binding,
      );
      if (!bound) {
        throw refuse("channel_mismatch");
      }
      db.transaction(() => {
        // The old record must still be the one that was proven.
        const login = loginOf(personId);
        if (!login || login.registrationRecord !== entry.record) {
          throw new AuthError("expired");
        }
        db.update(authLogins)
          .set({
            registrationRecord: input.registrationRecord,
            keyStretching: input.keyStretching,
            updatedAt: now(),
          })
          .where(eq(authLogins.personId, personId))
          .run();
        record({
          action: "password.change",
          outcome: "ok",
          personId,
          clientId: principal.client.id,
        });
      });
      limiter.succeeded(address);
    },

    // Choosing a new password without the current one, on a device signed
    // in as you: its sign-in is the proof, as any device at home could
    // already make you a code for a new password. Only for your own
    // sign-in, from a personal device; the username stays.
    passwordChooseStart(
      principal: Principal,
      address: string,
      input: PasswordChooseStart,
    ): RegistrationStarted {
      const personId = personal(principal);
      host();
      const login = loginOf(personId);
      if (!login) {
        throw new AuthError("not_found");
      }
      limiter.attempt(address);
      const response = registrationResponse(
        login.username,
        input.registrationRequest,
      );
      const registrationId = pending.add({
        kind: "choose",
        address,
        clientId: principal.client.id,
        personId,
        username: login.username,
        record: login.registrationRecord,
      });
      return { registrationId, registrationResponse: response };
    },

    passwordChooseFinish(
      principal: Principal,
      address: string,
      input: PasswordChooseFinish,
    ) {
      const personId = personal(principal);
      const entry = take("choose", input.registrationId, address);
      if (!entry || entry.clientId !== principal.client.id) {
        throw new AuthError("expired");
      }
      db.transaction(() => {
        // The sign-in must be the one this started from: same username,
        // and no other change since.
        const login = loginOf(personId);
        if (
          !login ||
          login.username !== entry.username ||
          login.registrationRecord !== entry.record
        ) {
          throw new AuthError("expired");
        }
        db.update(authLogins)
          .set({
            registrationRecord: input.registrationRecord,
            keyStretching: input.keyStretching,
            updatedAt: now(),
          })
          .where(eq(authLogins.personId, personId))
          .run();
        record({
          action: "password.choose",
          outcome: "ok",
          personId,
          clientId: principal.client.id,
        });
      });
      limiter.succeeded(address);
    },
  };
}

export type Logins = ReturnType<typeof createLogins>;
