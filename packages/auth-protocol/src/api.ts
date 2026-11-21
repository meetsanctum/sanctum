// The shapes of Auth's routes and its live-update handshake, as the core
// serves them and the apps call them. Dates travel as ISO strings.

export const platforms = [
  "macos",
  "windows",
  "linux",
  "ios",
  "android",
  "web",
] as const;
export type Platform = (typeof platforms)[number];

/**
 * A personal client is a person's, a shared client the household's, and an
 * agent is an AI agent someone added, which reaches the home's MCP endpoint
 * and nothing else.
 */
export type ClientKind = "personal" | "shared" | "agent";

/** Client tokens carry a type prefix so logs and secret scanners can tell them apart. */
export const clientTokenPrefix = "client_";

/** Page tickets carry one too: they open apps' page files and the kit, nothing else. */
export const pageTicketPrefix = "page_";

/**
 * `POST /api/pages/ticket`: a ticket for this client's frames to load apps'
 * page files and the kit with, in their address, and the kit they load. A
 * client asks for the next one before this one's week is out; each works a
 * day past it, so a page that's open keeps loading.
 */
export type PageTicket = {
  ticket: string;
  expiresAt: string;
  /** The home's kit, or none where its core has none. */
  kit: { version: string; bridge: number; digest: string } | null;
};

/**
 * `GET /api/pages/apps/:appId`: the build of an installed app's pages the
 * core serves now, which a frame's address names, and the kit it serves
 * them with now (a core from before it says none).
 */
export type AppPages = {
  digest: string;
  kit?: { version: string; bridge: number; digest: string };
};

/**
 * Its refusal when the app's pages don't fit the home's kit: they need a
 * newer home ("sanctum") or a new build of the app's pages ("pages").
 */
export type AppPagesMisfit = { error: "not_found"; needs: "sanctum" | "pages" };

/**
 * `GET /api/auth/status`: the host's id, the id of the home it serves
 * and whether it is claimed.
 */
export type HostStatus = { hostId: string; homeId: string; claimed: boolean };

/** A core's status, or none when the body is not one. */
export function readHostStatus(body: unknown): HostStatus | null {
  const status = body as Partial<Record<keyof HostStatus, unknown>> | null;
  if (
    typeof status?.hostId !== "string" ||
    !status.hostId ||
    typeof status.homeId !== "string" ||
    !status.homeId ||
    typeof status.claimed !== "boolean"
  ) {
    return null;
  }
  return {
    hostId: status.hostId,
    homeId: status.homeId,
    claimed: status.claimed,
  };
}

export type PersonInfo = {
  id: string;
  name: string;
  avatar: string | null;
  colour: string;
};

// People's routes: every client lists, adds, changes and removes them.
export type AddPerson = {
  name: string;
  colour: string;
  avatar?: string | null;
};
export type ChangePerson = { id: string } & Partial<AddPerson>;
export type RemovePerson = { id: string };

export type ClientInfo = {
  id: string;
  name: string;
  kind: ClientKind;
  platform: Platform;
  personId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  /** Since when it has been connected, while it has a live connection open. */
  connectedSince: string | null;
  /** The client the request came from. */
  current: boolean;
};

/** The device a claim or sign-in creates a client for. */
export type NewClient = { name: string; platform: Platform };

// Registering a password takes two calls: the first answers the device's
// registration request, the second stores the record it made.
export type RegistrationStarted = {
  registrationId: string;
  registrationResponse: string;
};

export type ClaimStart = { username: string; registrationRequest: string };
export type ClaimFinish = {
  registrationId: string;
  registrationRecord: string;
  keyStretching: number;
  person: { name: string; colour: string; avatar?: string | null };
  client: NewClient;
};

export type SignInStart = { username: string; startLoginRequest: string };
export type SignInStarted = { signInId: string; loginResponse: string };
export type SignInFinish = {
  signInId: string;
  finishLoginRequest: string;
  binding: string;
  client: NewClient;
};

export type SignedIn = {
  token: string;
  /** The host's MAC over itself and the token; sign-in only, since a claim has nothing to check yet. */
  confirmation?: string;
  client: ClientInfo;
  person: PersonInfo;
};

export type Me = { client: ClientInfo; person: PersonInfo | null };

// Pairing a shared device: it asks for a request and polls with its device
// secret, while someone looks its display code up on another of the home's
// clients and approves it.
export type PairRequest = { platform: Platform; suggestedName: string };
export type PairRequested = {
  /** The display code, as the core stores it (see formatPairingCode). */
  code: string;
  /** Only the device holding this can collect the token. */
  deviceSecret: string;
  expiresAt: string;
};

export type PairLookup = { code: string };
/** What the approving client sees of a request: never its secret. */
export type PairingRequestInfo = {
  code: string;
  platform: Platform;
  suggestedName: string;
  /** The address the device asked from. */
  address: string;
  createdAt: string;
  expiresAt: string;
};

export type PairApprove = { code: string; name: string };

export type PairPoll = { deviceSecret: string };
export type PairPolled =
  | { status: "waiting" }
  | { status: "paired"; token: string; client: ClientInfo };

export type RenameClient = { id: string; name: string };
export type RevokeClient = { id: string };

export type SetLoginStart = {
  personId: string;
  username: string;
  registrationRequest: string;
};
export type SetLoginFinish = {
  registrationId: string;
  registrationRecord: string;
  keyStretching: number;
};
export type RemoveLogin = { personId: string };

// Changing your own password proves the current one and registers the new
// one in the same two calls.
export type PasswordStart = {
  startLoginRequest: string;
  registrationRequest: string;
};
export type PasswordStarted = {
  changeId: string;
  loginResponse: string;
  registrationResponse: string;
};
export type PasswordFinish = {
  changeId: string;
  finishLoginRequest: string;
  binding: string;
  registrationRecord: string;
  keyStretching: number;
};

export type AuthErrorCode =
  | "invalid_request"
  | "invalid_client_token"
  | "sign_in_failed"
  // A pending registration, password change or pairing request expired or
  // was used.
  | "expired"
  | "channel_mismatch"
  | "forbidden"
  // Changing a password needs the person it belongs to: a shared client
  // has none.
  | "needs_personal_client"
  | "not_found"
  | "claimed"
  | "username_taken"
  | "last_login"
  | "too_many_attempts"
  | "busy"
  | "host_starting";

export type AuthErrorBody = { error: AuthErrorCode };

// The live-update WebSocket authenticates with its first message, since
// browsers cannot set headers on one.
export const livePath = "/api/live";
export const liveAuthTimeoutMs = 5_000;
/** The close code for a missing, unknown or revoked token. */
export const liveInvalidTokenCode = 4401;
/** The close code when no auth message came in time. */
export const liveAuthTimeoutCode = 4408;

export type LiveAuth = { type: "auth"; token: string };
export type LiveReady = { type: "ready" };
