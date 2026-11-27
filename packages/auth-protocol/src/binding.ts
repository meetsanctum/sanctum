// Binds an OPAQUE exchange to the host each side sees. Runs in the core and
// in the apps' web views. Plain HTTP development origins fall back to
// software HKDF and HMAC where browsers don't expose WebCrypto's SubtleCrypto.
//
// OPAQUE leaves the device and the real host with the same session key, which
// nobody in between can learn. Each side MACs what it sees under a key
// derived from it:
// - the device's binding lets the host refuse a sign-in, a password change
//   or a shared device's pairing that came through an interceptor, before
//   anything is created;
// - the host's confirmation lets the device check that the token came from
//   the host it is about to pin.
//
// Each covers the host id, the home id and the host CA's pin the device saw
// (pin.ts). Over plain HTTP, in development only, there is no certificate,
// so the pin is null. A host that has a pin always binds it, so a device
// that saw none fails against it.

import { pairingProtocol } from "./pairing.js";

export type HostView = { hostId: string; homeId: string; pin: string | null };

const text = new TextEncoder();

function fromBase64url(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function toBase64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

type Purpose =
  | "client"
  | "server"
  | "password"
  | "pairing device"
  | "pairing host"
  | "invite device"
  | "invite host";

// Sign-in's labels keep their version; pairing's and invites' keys have
// labels of their own, so a MAC made for one exchange never checks for
// another.
function label(purpose: Purpose) {
  return purpose.startsWith("pairing") || purpose.startsWith("invite")
    ? `sanctum ${purpose} binding v1`
    : // v2: v1 bound the host id and pin alone, before home ids.
      `sanctum sign-in binding v2 ${purpose}`;
}

async function macKey(
  subtle: SubtleCrypto,
  sessionKey: string,
  purpose: Purpose,
) {
  const ikm = await subtle.importKey(
    "raw",
    fromBase64url(sessionKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: text.encode(label(purpose)),
    },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

async function softwareMac(
  sessionKey: string,
  purpose: Purpose,
  data: Uint8Array,
) {
  const [{ hkdf }, { hmac }, { sha256 }] = await Promise.all([
    import("@noble/hashes/hkdf"),
    import("@noble/hashes/hmac"),
    import("@noble/hashes/sha256"),
  ]);
  const key = hkdf(
    sha256,
    fromBase64url(sessionKey),
    undefined,
    text.encode(label(purpose)),
    32,
  );
  return hmac(sha256, key, data);
}

// Every field is a UUID, a number, base64url or a username, so a newline
// cannot appear inside one.
function message(fields: string[]) {
  return text.encode(fields.join("\n"));
}

function hostFields({ hostId, homeId, pin }: HostView) {
  return [hostId, homeId, pin ?? ""];
}

async function sign(
  sessionKey: string,
  purpose: Purpose,
  host: HostView,
  fields: string[],
) {
  const data = message([...hostFields(host), ...fields]);
  const subtle = globalThis.crypto.subtle;
  if (!subtle) {
    return toBase64url(await softwareMac(sessionKey, purpose, data));
  }
  const key = await macKey(subtle, sessionKey, purpose);
  return toBase64url(new Uint8Array(await subtle.sign("HMAC", key, data)));
}

async function verify(
  sessionKey: string,
  purpose: Purpose,
  host: HostView,
  fields: string[],
  mac: string,
) {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64url(mac);
  } catch {
    return false;
  }
  const data = message([...hostFields(host), ...fields]);
  const subtle = globalThis.crypto.subtle;
  if (!subtle) {
    const expected = await softwareMac(sessionKey, purpose, data);
    if (bytes.length !== expected.length) return false;
    // Compare every byte before deciding whether the MAC matches.
    let difference = 0;
    for (let i = 0; i < expected.length; i++) {
      difference |= bytes[i]! ^ expected[i]!;
    }
    return difference === 0;
  }
  const key = await macKey(subtle, sessionKey, purpose);
  return subtle.verify("HMAC", key, bytes, data);
}

/** The device's MAC over the host it sees, sent with `sign-in/finish`. */
export function signInBinding(sessionKey: string, host: HostView) {
  return sign(sessionKey, "client", host, []);
}

export function verifySignInBinding(
  sessionKey: string,
  host: HostView,
  binding: string,
) {
  return verify(sessionKey, "client", host, [], binding);
}

/** The host's MAC over itself and the token it issued. */
export function signInConfirmation(
  sessionKey: string,
  host: HostView,
  token: string,
) {
  return sign(sessionKey, "server", host, [token]);
}

export function verifySignInConfirmation(
  sessionKey: string,
  host: HostView,
  token: string,
  confirmation: string,
) {
  return verify(sessionKey, "server", host, [token], confirmation);
}

/**
 * The device's MAC for changing its own password: the proof of the current
 * password, bound to the host and to the new registration record.
 */
export function passwordChangeBinding(
  sessionKey: string,
  host: HostView,
  registrationRecord: string,
) {
  return sign(sessionKey, "password", host, [registrationRecord]);
}

export function verifyPasswordChangeBinding(
  sessionKey: string,
  host: HostView,
  registrationRecord: string,
  binding: string,
) {
  return verify(sessionKey, "password", host, [registrationRecord], binding);
}

/** Which exchange of which pairing request a MAC belongs to. */
export type PairingExchangeIds = { requestId: string; exchangeId: string };

function exchangeFields(ids: PairingExchangeIds) {
  return [String(pairingProtocol), ids.requestId, ids.exchangeId];
}

/**
 * A shared device's MAC over the host it sees, sent with its view once the
 * pairing exchange finished, so the host can tell an interceptor from a
 * wrong code.
 */
export function pairingBinding(
  sessionKey: string,
  host: HostView,
  ids: PairingExchangeIds,
) {
  return sign(sessionKey, "pairing device", host, exchangeFields(ids));
}

export function verifyPairingBinding(
  sessionKey: string,
  host: HostView,
  ids: PairingExchangeIds,
  binding: string,
) {
  return verify(
    sessionKey,
    "pairing device",
    host,
    exchangeFields(ids),
    binding,
  );
}

/** The host's MAC over itself and the token it gives a shared device. */
export function pairingConfirmation(
  sessionKey: string,
  host: HostView,
  ids: PairingExchangeIds,
  token: string,
) {
  return sign(sessionKey, "pairing host", host, [
    ...exchangeFields(ids),
    token,
  ]);
}

export function verifyPairingConfirmation(
  sessionKey: string,
  host: HostView,
  ids: PairingExchangeIds,
  token: string,
  confirmation: string,
) {
  return verify(
    sessionKey,
    "pairing host",
    host,
    [...exchangeFields(ids), token],
    confirmation,
  );
}

// Redeeming an invite: the device proves its code with OPAQUE, as signing
// in proves a password, and MACs the host it sees twice, once when the code
// is checked and once over the username and password it chose, so the host
// saves them only for a device that reached it directly.

/** The device's MAC when its invite code is checked. */
export function inviteCheckBinding(sessionKey: string, host: HostView) {
  return sign(sessionKey, "invite device", host, ["check"]);
}

export function verifyInviteCheckBinding(
  sessionKey: string,
  host: HostView,
  binding: string,
) {
  return verify(sessionKey, "invite device", host, ["check"], binding);
}

/** The device's MAC over the username and the new password's record. */
export function inviteFinishBinding(
  sessionKey: string,
  host: HostView,
  username: string,
  registrationRecord: string,
) {
  return sign(sessionKey, "invite device", host, [
    "finish",
    username,
    registrationRecord,
  ]);
}

export function verifyInviteFinishBinding(
  sessionKey: string,
  host: HostView,
  username: string,
  registrationRecord: string,
  binding: string,
) {
  return verify(
    sessionKey,
    "invite device",
    host,
    ["finish", username, registrationRecord],
    binding,
  );
}

/** The host's MAC over itself and the token it issued for a redeemed invite. */
export function inviteConfirmation(
  sessionKey: string,
  host: HostView,
  token: string,
) {
  return sign(sessionKey, "invite host", host, [token]);
}

export function verifyInviteConfirmation(
  sessionKey: string,
  host: HostView,
  token: string,
  confirmation: string,
) {
  return verify(sessionKey, "invite host", host, [token], confirmation);
}
