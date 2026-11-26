import {
  newPairingSecret,
  pairingBinding,
  pairingOpaque,
  pairingProtocol,
  verifyPairingConfirmation,
  type HostView,
  type NewClient,
  type PairAnswered,
  type PairApprove,
  type PairExchange,
  type PairingExchangeIds,
  type PairExchangeStarted,
  type PairExchangeStatus,
  type PairPolled,
  type PairRequested,
} from "@meetsanctum/auth-protocol";

import { coreJson } from "../core-fetch";
import { loadOpaque } from "./device";

// Pairing a shared device. The device's side asks the host it chose for a
// request, shows a code whose second half it drew itself, and answers the
// exchange the host starts once someone types the code: first contact, so it
// never carries a stored token. The approving side types the code, follows
// the exchange and approves the device from another of the home's clients.

export function requestPairing(
  url: string,
  client: NewClient,
  signal?: AbortSignal,
) {
  return coreJson<PairRequested>("/api/auth/pair/request", {
    at: url,
    signal,
    method: "POST",
    json: {
      platform: client.platform,
      suggestedName: client.name,
      protocol: pairingProtocol,
    },
    omitToken: true,
  });
}

export function pollPairing(
  url: string,
  deviceSecret: string,
  signal?: AbortSignal,
) {
  return coreJson<PairPolled>("/api/auth/pair/poll", {
    at: url,
    signal,
    method: "POST",
    json: { deviceSecret },
    omitToken: true,
  });
}

/**
 * The code a shared device shows: the host's lookup and a secret the device
 * draws and never sends, of which it keeps a one-time OPAQUE record in
 * memory only. Each code has its own server setup.
 */
export async function showCode(lookup: string) {
  const opaque = await loadOpaque();
  const { identifiers, userIdentifier, keyStretching } = pairingOpaque;
  const secret = newPairingSecret();
  const serverSetup = opaque.server.createSetup();
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password: secret });
  const { registrationResponse } = opaque.server.createRegistrationResponse({
    serverSetup,
    userIdentifier,
    registrationRequest,
  });
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password: secret,
    identifiers,
    keyStretching,
  });
  return {
    code: `${lookup}${secret}`,
    // OPAQUE's second message, for the host's first.
    respond(startLoginRequest: string) {
      return opaque.server.startLogin({
        serverSetup,
        registrationRecord,
        startLoginRequest,
        userIdentifier,
        identifiers,
      });
    },
    // The session key once the host's last message checks, or none.
    finish(serverLoginState: string, finishLoginRequest: string) {
      try {
        return opaque.server.finishLogin({
          serverLoginState,
          finishLoginRequest,
          identifiers,
        }).sessionKey;
      } catch {
        return null;
      }
    },
  };
}

export type ShownCode = Awaited<ReturnType<typeof showCode>>;

/**
 * Answers the exchange the host started, then binds it to the host this
 * device sees. Returns the session key once the host accepted the binding,
 * or none when the exchange didn't finish, as with a mistyped code.
 */
export async function answerExchange(input: {
  url: string;
  shown: ShownCode;
  deviceSecret: string;
  ids: PairingExchangeIds;
  startLoginRequest: string;
  host: HostView;
  signal?: AbortSignal;
}) {
  const { url, shown, deviceSecret, ids, signal } = input;
  const { serverLoginState, loginResponse } = shown.respond(
    input.startLoginRequest,
  );
  const answered = await coreJson<PairAnswered>("/api/auth/pair/answer", {
    at: url,
    signal,
    method: "POST",
    json: { deviceSecret, exchangeId: ids.exchangeId, loginResponse },
    omitToken: true,
  });
  if (answered.status !== "continue") {
    return null;
  }
  const sessionKey = shown.finish(
    serverLoginState,
    answered.finishLoginRequest,
  );
  if (!sessionKey) {
    return null;
  }
  await coreJson<void>("/api/auth/pair/bind", {
    at: url,
    signal,
    method: "POST",
    json: {
      deviceSecret,
      exchangeId: ids.exchangeId,
      ...input.host,
      binding: await pairingBinding(sessionKey, input.host, ids),
    },
    omitToken: true,
  });
  return sessionKey;
}

/** Whether a collected token came from the host the exchange checked. */
export function confirmsPairing(
  sessionKey: string,
  host: HostView,
  ids: PairingExchangeIds,
  polled: Extract<PairPolled, { status: "paired" }>,
) {
  return verifyPairingConfirmation(
    sessionKey,
    host,
    ids,
    polled.token,
    polled.confirmation,
  );
}

export function lookupPairing(code: string, signal?: AbortSignal) {
  return coreJson<PairExchangeStarted>("/api/auth/pair/lookup", {
    method: "POST",
    json: { code },
    signal,
  });
}

export function pairingExchange(input: PairExchange, signal?: AbortSignal) {
  return coreJson<PairExchangeStatus>("/api/auth/pair/exchange", {
    method: "POST",
    json: input,
    signal,
  });
}

export function approvePairing(input: PairApprove, signal?: AbortSignal) {
  return coreJson<void>("/api/auth/pair/approve", {
    method: "POST",
    json: input,
    signal,
  });
}
