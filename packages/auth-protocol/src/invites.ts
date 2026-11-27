// Inviting a person to sign in: whoever adds them makes a one-time code on
// their own device, and the person types it on theirs and chooses their own
// username and password there. The code is a one-time password: its first
// characters are a lookup the core gives, the rest a secret the inviting
// device draws and registers through OPAQUE, so the core never sees it.
// Typing it checks the home as signing in does. Codes use the pairing code's
// alphabet and shape, so they read and type the same.

import {
  formatPairingCode,
  newPairingSecret,
  normalisePairingCode,
  splitPairingCode,
} from "./pairing.js";

/** An invite ends this long after it was made, unless it was used first. */
export const inviteMs = 24 * 60 * 60_000;

/**
 * How many challenges the core issues for an invite before a cooldown.
 * OPAQUE fails a wrong code on the device, which sends nothing more, so the
 * core counts challenges it issues. A successful check clears the count.
 */
export const inviteTries = 5;

/**
 * How long a person has, once their code checked, to choose a username and
 * password.
 */
export const inviteChooseMs = 10 * 60_000;

/** The inviting device's secret: the code's characters after the lookup. */
export const newInviteSecret = newPairingSecret;

/** A typed code as the core reads it, or none when it can't be one. */
export const normaliseInviteCode = normalisePairingCode;

/** The lookup the core finds the invite by, and the secret it checks. */
export const splitInviteCode = splitPairingCode;

/** The code as people read it: `K7QX-M4PD`. */
export const formatInviteCode = formatPairingCode;

/**
 * The name an invite's code is registered under, which OPAQUE's key for it
 * is derived from. A login's is its username; an invite has none until the
 * person chooses one.
 */
export function inviteIdentifier(inviteId: string) {
  return `invite:${inviteId}`;
}
