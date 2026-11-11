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
import { and, count, eq, isNotNull } from "drizzle-orm";

import type { RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import type { People, Person } from "../people/people.js";
import { personalCaller } from "./callers.js";
import { clientInfo, type Clients, type Principal } from "./clients.js";
import { AuthError } from "./errors.js";
import { createPendingStore, type Limiter, type Limits } from "./limits.js";
import { authLogins, authServer } from "./schema.js";

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

// OPAQUE's server functions throw on malformed messages.
function protocol<T>(step: () => T) {
  try {
    return step();
  } catch {
    throw new AuthError("invalid_request");
  }
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

  function registrationResponse(name: string, registrationRequest: string) {
    limiter.work();
    return protocol(() =>
      opaque.server.createRegistrationResponse({
        serverSetup,
        userIdentifier: name,
        registrationRequest,
      }),
    ).registrationResponse;
  }

  function startLogin(
    name: string,
    record: string | null,
    startLoginRequest: string,
  ) {
    limiter.work();
    return protocol(() =>
      opaque.server.startLogin({
        serverSetup,
        registrationRecord: record,
        startLoginRequest,
        userIdentifier: name,
      }),
    );
  }

  // The session key, or none when the device's last message does not check.
  function finishLogin(serverLoginState: string, finishLoginRequest: string) {
    limiter.work();
    try {
      return opaque.server.finishLogin({ serverLoginState, finishLoginRequest })
        .sessionKey;
    } catch {
      return undefined;
    }
  }

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
        const values = {
          username: entry.username,
          registrationRecord: input.registrationRecord,
          keyStretching: input.keyStretching,
          updatedAt: now(),
        };
        db.insert(authLogins)
          .values({ personId: entry.personId, ...values })
          .onConflictDoUpdate({ target: authLogins.personId, set: values })
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

    // Refused if it would leave the claimed host without anyone who can
    // sign in.
    removeLogin(principal: Principal, input: RemoveLogin) {
      db.transaction(() => {
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
        record({
          action: "login.remove",
          outcome: "ok",
          personId: principal.person?.id,
          clientId: principal.client.id,
          subjectId: input.personId,
        });
      });
      pending.drop(
        (entry) => "personId" in entry && entry.personId === input.personId,
      );
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
  };
}

export type Logins = ReturnType<typeof createLogins>;
