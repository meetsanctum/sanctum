import type { AuthErrorBody } from "@meetsanctum/auth-protocol";

import { coreBaseUrl, coreUrl } from "./core-url";

// The one fetch helper for the core. Components never attach tokens
// themselves: this helper adds the client token only to core-relative paths
// whose resolved origin is the stored core's, refuses redirects, and forgets
// the token when the core reports that same token invalid. The shell's pin
// check underneath is the other condition: a connection reaches the core
// only with its pinned CA, and while a first contact is checked, no request
// carries a token. Over plain HTTP in development there is none.

// The client token this client holds, the core that issued it, and the pin
// of that core's CA; none over plain HTTP.
export type Credential = { url: string; token: string; pin: string | null };

let credential: Credential | null = null;
const invalidListeners = new Set<(token: string) => void>();

export function setCredential(next: Credential | null) {
  credential = next;
}

export function currentCredential() {
  return credential;
}

// Called when the core reports the held token missing, unknown or revoked:
// the device was removed.
export function onTokenInvalid(listener: (token: string) => void) {
  invalidListeners.add(listener);
  return () => {
    invalidListeners.delete(listener);
  };
}

export class CoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    // The refusal's whole body, for what some carry beside their code,
    // such as a workflow's problems.
    readonly body?: unknown,
  ) {
    super(`The core answered ${status} ${code}`);
  }
}

export type CoreFetchInit = Omit<RequestInit, "body"> & {
  // A JSON body.
  json?: unknown;
  // First contact (status, claim, sign-in) never carries a stored token,
  // even at the same origin.
  omitToken?: boolean;
  // An address to ask instead of the core's: the host chosen at first
  // contact, or another address it may answer at once it moved. Never
  // carries a token.
  at?: string;
  // The app whose page asks, which the core answers with what that app may
  // see as well as this client.
  app?: string;
};

// The token to send to `url`, if any.
export function tokenFor(url: URL, init: { omitToken?: boolean } = {}) {
  if (init.omitToken || !credential) {
    return undefined;
  }
  return url.origin === new URL(credential.url).origin
    ? credential.token
    : undefined;
}

// Forgets `token` if it is still the one held, and tells the listeners.
export function forgetToken(token: string) {
  if (credential?.token !== token) {
    return;
  }
  credential = null;
  for (const listener of invalidListeners) {
    listener(token);
  }
}

export async function coreFetch(path: string, init: CoreFetchInit = {}) {
  if (!path.startsWith("/api/")) {
    throw new TypeError(`Not a core path: ${path}`);
  }
  const { json, omitToken, at, app, ...rest } = init;
  const base = at ?? coreBaseUrl();
  const url = new URL(at ? new URL(path, at).href : coreUrl(path));
  if (url.origin !== new URL(base).origin) {
    throw new TypeError(`Not a core path: ${path}`);
  }
  const headers = new Headers(rest.headers);
  headers.delete("authorization");
  const token = tokenFor(url, { omitToken: omitToken || !!at });
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  if (json !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (app !== undefined) {
    headers.set("x-sanctum-app", app);
  }
  const response = await fetch(url, {
    ...rest,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
    credentials: "omit",
    redirect: "error",
  });
  if (response.status === 401 && token) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as Partial<AuthErrorBody> | null;
    if (body?.error === "invalid_client_token") {
      forgetToken(token);
    }
  }
  return response;
}

// Like coreFetch, for JSON answers; refusals throw a CoreError with the
// core's error code.
export async function coreJson<T>(path: string, init: CoreFetchInit = {}) {
  const response = await coreFetch(path, init);
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => null)) as Partial<AuthErrorBody> | null;
    throw new CoreError(response.status, body?.error ?? "unknown", body);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}
