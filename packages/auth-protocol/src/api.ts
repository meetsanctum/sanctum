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
  /** Whether it draws with Reduce effects: set on any client (Settings → Linked Devices). */
  reduceEffects: boolean;
  /** Whether it draws with Reduce motion, set on its own as Reduce effects is. */
  reduceMotion: boolean;
};

/** Turns a client's Reduce effects or Reduce motion on or off; one left out stays as it is. */
export type SetClientDrawing = {
  id: string;
  reduceEffects?: boolean;
  reduceMotion?: boolean;
};

/** The device a claim or sign-in creates a client for. */
export type NewClient = { name: string; platform: Platform };

// Registering a password takes two calls: the first answers the device's
// registration request, the second stores the record it made.
export type RegistrationStarted = {
  registrationId: string;
  registrationResponse: string;
};
export type RegistrationFinish = {
  registrationId: string;
  registrationRecord: string;
  keyStretching: number;
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
  /** The host's MAC over itself and the token. Omitted for initial claims. */
  confirmation?: string;
  client: ClientInfo;
  person: PersonInfo;
};

export type Me = { client: ClientInfo; person: PersonInfo | null };

// Pairing a shared device: it asks for a request and polls with its device
// secret, while someone types its display code on another of the home's
// clients. The core then runs the OPAQUE exchange with the device through
// its polls (pairing.ts), and whoever typed the code watches it and approves
// the device once the exchange checked the host.
export type PairRequest = {
  platform: Platform;
  suggestedName: string;
  /** The pairing exchange the device speaks (pairingProtocol). */
  protocol: number;
};
export type PairRequested = {
  requestId: string;
  /** The code's first characters; the device draws the rest. */
  lookup: string;
  /** Only the device holding this can answer its exchanges and collect. */
  deviceSecret: string;
  expiresAt: string;
};

export type PairLookup = { code: string };
/** The exchange the core started with the device that shows the code. */
export type PairExchangeStarted = { requestId: string; exchangeId: string };

export type PairExchange = { requestId: string; exchangeId: string };
/** Why an exchange didn't check the device. */
export type PairExchangeFailure =
  // The code typed is not the one the device shows.
  | "wrong_code"
  // The device didn't answer in time.
  | "no_answer"
  // The exchange didn't finish, so the host couldn't check the device.
  | "unchecked"
  // The device sees another host: something is in between.
  | "channel_mismatch";
export type PairExchangeStatus =
  | { status: "exchanging" }
  | { status: "verified"; request: PairingRequestInfo }
  | { status: "failed"; reason: PairExchangeFailure };

/** What the approving client sees of a request once it is checked. */
export type PairingRequestInfo = {
  platform: Platform;
  suggestedName: string;
  createdAt: string;
  expiresAt: string;
};

export type PairApprove = {
  requestId: string;
  exchangeId: string;
  name: string;
};

export type PairPoll = { deviceSecret: string };
export type PairPolled =
  | { status: "waiting" }
  // The core started an exchange: OPAQUE's first message for the device.
  | { status: "exchange"; exchangeId: string; startLoginRequest: string }
  | {
      status: "paired";
      token: string;
      client: ClientInfo;
      /** The host's MAC over itself and the token (pairingConfirmation). */
      confirmation: string;
    };

/** The device's answer to an exchange: OPAQUE's second message. */
export type PairAnswer = {
  deviceSecret: string;
  exchangeId: string;
  loginResponse: string;
};
export type PairAnswered =
  { status: "continue"; finishLoginRequest: string } | { status: "failed" };

/** The device's view of the host, bound to the exchange (pairingBinding). */
export type PairBind = {
  deviceSecret: string;
  exchangeId: string;
  hostId: string;
  homeId: string;
  pin: string | null;
  binding: string;
};

export type RenameClient = { id: string; name: string };
export type RevokeClient = { id: string };

export type SetLoginStart = {
  personId: string;
  username: string;
  registrationRequest: string;
};
export type SetLoginFinish = RegistrationFinish;
export type RemoveLogin = { personId: string };

/** `GET /api/auth/logins`: who signs in, and with which username. */
export type LoginInfo = { personId: string; username: string };

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

// Choosing a new password on a device signed in as you, when you've
// forgotten the current one: the device registers the new one, and the
// sign-in it holds is the proof. The answer to the start is a
// RegistrationStarted.
export type PasswordChooseStart = { registrationRequest: string };
export type PasswordChooseFinish = RegistrationFinish;

// Inviting a person to sign in (invites.ts). Any client makes, lists and
// cancels invites; redeeming one needs no token, as signing in doesn't.

/**
 * Why an invite that wasn't used ended. Too many wrong codes don't end one:
 * its code rests for a while, so nobody else can end it by guessing.
 */
export type InviteEnded = "expired" | "cancelled";

/**
 * A person's invite: an invite to sign in for someone without a sign-in,
 * or a reset for someone who forgot their password, whose current one keeps
 * working until the code is used. One per person at most. Beside it, a
 * recovery code: a reset with no end the person makes for themselves, on
 * their own device, and only their own devices list.
 */
export type InviteInfo = {
  id: string;
  personId: string;
  createdAt: string;
  /** Why the invite ended, or none while it is active. */
  ended: InviteEnded | null;
} & (
  | { kind: "invite" | "reset"; endsAt: string }
  | { kind: "recovery"; endsAt: null }
);

export type InviteStart = {
  personId: string;
  /** The active code the sender confirmed they want to replace, if any. */
  replacesInviteId?: string;
  registrationRequest: string;
} & ({ kind: "invite" | "reset" } | { kind: "recovery"; lookup: string });
export type InviteStarted = RegistrationStarted & {
  /** The prefix for an invite or reset, or the digest for a recovery code. */
  lookup: string;
};
export type InviteFinish = RegistrationFinish;
export type CancelInvite = {
  personId: string;
  inviteId: string;
  kind?: "recovery";
};

// Redeeming takes four calls: OPAQUE's first round with the code's secret,
// the check that the code and the home are right (the person then sees whose
// invite it is), the new password's registration, and the end, which saves
// the new sign-in and creates the device's personal client.
export type RedeemStart = { lookup: string; startLoginRequest: string };
export type RedeemStarted = {
  redeemId: string;
  loginResponse: string;
  /** The key-stretching version to use when proving the code. */
  keyStretching: number;
};
export type RedeemCheck = {
  redeemId: string;
  finishLoginRequest: string;
  binding: string;
};
export type RedeemChecked = {
  /** The checked code's, for choosing the username and password. */
  redeemId: string;
  person: PersonInfo;
  /** A reset's current username, which the person may keep. */
  username: string | null;
};
export type RedeemRegister = {
  redeemId: string;
  username: string;
  registrationRequest: string;
};
export type RedeemRegistered = {
  registrationResponse: string;
  /** The canonical username to use in the finish binding. */
  username: string;
};
export type RedeemFinish = {
  redeemId: string;
  registrationRecord: string;
  keyStretching: number;
  /** The device's MAC over the host, the username and the new record. */
  binding: string;
  client: NewClient;
};
export type RedeemFinished = SignedIn & { confirmation: string };

export type AuthErrorCode =
  | "invalid_request"
  | "invalid_client_token"
  | "sign_in_failed"
  // A pending registration, password change or pairing request expired or
  // was used.
  | "expired"
  | "pairing_outdated"
  | "channel_mismatch"
  | "forbidden"
  // Changing a password needs the person it belongs to: a shared client
  // has none.
  | "needs_personal_client"
  | "not_found"
  | "claimed"
  | "username_taken"
  | "last_login"
  // An invite code that was right but can no longer be redeemed.
  | "invite_ended"
  | "invite_changed"
  | "invite_kind_changed"
  | "too_many_attempts"
  | "busy"
  | "host_starting"
  // An AI agent's connector the home can't work with: one too new needs
  // Sanctum updated, one too old needs the connector updated.
  | "connector_too_new"
  | "connector_too_old";

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
/** The client's own record changed on another client: it reads Me again. */
export type LiveClientChanged = { type: "client" };
