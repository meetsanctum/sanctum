import {
  keyStretching,
  normalisePassword,
  normaliseUsername,
  readHostStatus,
  signInBinding,
  verifySignInConfirmation,
  type ClaimFinish,
  type NewClient,
  type HostStatus,
  type RegistrationStarted,
  type SignedIn,
  type SignInFinish,
  type SignInStarted,
} from "@meetsanctum/auth-protocol";

import { coreJson, CoreError } from "../core-fetch";
import { getShell, type FoundHost } from "../shell";

// The device's side of claiming and signing in. Passwords never leave the
// device: it registers and checks them through OPAQUE, and stretches them
// itself. These are first-contact exchanges, so they never carry a stored
// token.

// OPAQUE is WebAssembly, loaded only when a password is used.
async function loadOpaque() {
  const opaque = await import("@serenity-kit/opaque");
  await opaque.ready;
  return opaque;
}

export class SignInError extends Error {
  constructor(
    // The host did not prove itself, or another host or home answers where
    // the chosen one was found.
    readonly code:
      | "wrong_username_or_password"
      | "unconfirmed"
      | "another_host"
      // Nothing here can check the host's certificate (a plain browser).
      | "unchecked",
  ) {
    super(code);
  }
}

// The host at `at`, or at the core's address.
export async function hostStatus(
  at?: string,
  signal?: AbortSignal,
): Promise<HostStatus> {
  const status = readHostStatus(
    await coreJson<unknown>("/api/auth/status", {
      at,
      omitToken: true,
      signal: AbortSignal.any([
        AbortSignal.timeout(5_000),
        ...(signal ? [signal] : []),
      ]),
    }),
  );
  if (!status) {
    throw new CoreError(200, "unknown");
  }
  return status;
}

// What a first contact found: the candidate's pin, which the sign-in binds
// and a pairing QR code carries, none over plain HTTP in development; and
// the home's id.
export type CheckedHost = { pin: string | null; homeId: string };

// The first contact with the chosen host: the shell starts holding the CA it
// sees as a candidate, and the address must still answer as that host, and
// as the home the device expects if it knows one, before anything is sent to
// it.
export async function checkHost(
  host: Pick<FoundHost, "id" | "homeId" | "url">,
  signal?: AbortSignal,
): Promise<CheckedHost> {
  const { trust } = getShell();
  await trust?.check(host.id);
  const status = await hostStatus(host.url, signal);
  if (
    status.hostId !== host.id ||
    (host.homeId !== null && status.homeId !== host.homeId)
  ) {
    throw new SignInError("another_host");
  }
  if (new URL(host.url).protocol === "http:") {
    return { pin: null, homeId: status.homeId };
  }
  const pin = (await trust?.candidate()) ?? null;
  if (!pin) {
    throw new SignInError("unchecked");
  }
  return { pin, homeId: status.homeId };
}

export async function claimHost(input: {
  url: string;
  signal?: AbortSignal;
  username: string;
  password: string;
  person: ClaimFinish["person"];
  client: NewClient;
}): Promise<SignedIn> {
  const opaque = await loadOpaque();
  input.signal?.throwIfAborted();
  const password = normalisePassword(input.password);
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password });
  const started = await coreJson<RegistrationStarted>("/api/auth/claim/start", {
    at: input.url,
    signal: input.signal,
    method: "POST",
    json: { username: normaliseUsername(input.username), registrationRequest },
    omitToken: true,
  });
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: started.registrationResponse,
    password,
    keyStretching: keyStretching.profile,
  });
  return coreJson<SignedIn>("/api/auth/claim/finish", {
    at: input.url,
    signal: input.signal,
    method: "POST",
    json: {
      registrationId: started.registrationId,
      registrationRecord,
      keyStretching: keyStretching.version,
      person: input.person,
      client: input.client,
    } satisfies ClaimFinish,
    omitToken: true,
  });
}

// Signs in to the host with `hostId`, the one the person chose, bound to its
// home and the pin of the candidate CA the shell saw (checkHost). A wrong
// password fails here on the device, which then sends nothing more.
export async function signIn(input: {
  url: string;
  signal?: AbortSignal;
  hostId: string;
  homeId: string;
  pin: string | null;
  username: string;
  password: string;
  client: NewClient;
}): Promise<SignedIn> {
  const opaque = await loadOpaque();
  input.signal?.throwIfAborted();
  const password = normalisePassword(input.password);
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
    password,
  });
  const started = await coreJson<SignInStarted>("/api/auth/sign-in/start", {
    at: input.url,
    signal: input.signal,
    method: "POST",
    json: { username: normaliseUsername(input.username), startLoginRequest },
    omitToken: true,
  });
  const login = opaque.client.finishLogin({
    clientLoginState,
    loginResponse: started.loginResponse,
    password,
    keyStretching: keyStretching.profile,
  });
  if (!login) {
    throw new SignInError("wrong_username_or_password");
  }
  const host = { hostId: input.hostId, homeId: input.homeId, pin: input.pin };
  const signedIn = await coreJson<SignedIn>("/api/auth/sign-in/finish", {
    at: input.url,
    signal: input.signal,
    method: "POST",
    json: {
      signInId: started.signInId,
      finishLoginRequest: login.finishLoginRequest,
      binding: await signInBinding(login.sessionKey, host),
      client: input.client,
    } satisfies SignInFinish,
    omitToken: true,
  });
  const confirmed = await verifySignInConfirmation(
    login.sessionKey,
    host,
    signedIn.token,
    signedIn.confirmation ?? "",
  );
  if (!confirmed) {
    throw new SignInError("unconfirmed");
  }
  return signedIn;
}
