import type {
  NewClient,
  PairApprove,
  PairingRequestInfo,
  PairPolled,
  PairRequested,
} from "@meetsanctum/auth-protocol";

import { coreJson } from "../core-fetch";

// Pairing a shared device. The device's side asks the host it chose for a
// request and polls until someone approves it: first contact, so it never
// carries a stored token. The approving side looks the code up and approves
// it from another of the home's clients.

export function requestPairing(
  url: string,
  client: NewClient,
  signal?: AbortSignal,
) {
  return coreJson<PairRequested>("/api/auth/pair/request", {
    at: url,
    signal,
    method: "POST",
    json: { platform: client.platform, suggestedName: client.name },
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

export function lookupPairing(code: string, signal?: AbortSignal) {
  return coreJson<PairingRequestInfo>("/api/auth/pair/lookup", {
    method: "POST",
    json: { code },
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
