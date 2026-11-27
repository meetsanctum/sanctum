// Inviting a person to sign in: whoever adds them makes a one-time code on
// their own device, and the person types it on theirs and chooses their own
// username and password there. The code is a one-time password: its first
// characters are a lookup the core gives, the rest a secret the inviting
// device draws and registers through OPAQUE, so the core never sees it.
// Typing it checks the home as signing in does. Invites and resets use the
// pairing code's shape. Recovery codes use a longer secret.

import {
  formatPairingCode,
  newPairingSecret,
  normalisePairingCode,
  pairingCodeAlphabet,
  pairingLookupLength,
  randomCode,
  splitPairingCode,
} from "./pairing.js";

/** An invite ends this long after it was made, unless it was used first. */
export const inviteMs = 24 * 60 * 60_000;

/**
 * How many tries a code gets before it rests for the sign-in limiter's
 * window. OPAQUE fails a wrong code on the device, which sends nothing more,
 * so the core counts the tries it starts; a right code clears the count.
 * Resting, rather than ending, keeps someone guessing lookups from ending
 * other people's invites.
 */
export const inviteTries = 5;

/**
 * How long a person has, once their code checked, to choose a username and
 * password.
 */
export const inviteChooseMs = 10 * 60_000;

/** The inviting device's secret: the code's characters after the lookup. */
export const newInviteSecret = newPairingSecret;

// U is outside the short code's alphabet, so typing a recovery code never
// submits its first eight characters as an invite or reset.
export const recoveryCodePrefix = "U";
export const recoveryCodeLength = 32;
export const recoveryCodeVersion = 2;

/** A long-lived code draws 29 characters, giving over 128 bits of entropy. */
export function newRecoverySecret() {
  return randomCode(
    recoveryCodeLength - recoveryCodePrefix.length - pairingLookupLength,
  );
}

/** A typed code as the core reads it, or none when it can't be one. */
export function normaliseInviteCode(value: string) {
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  if (!code.startsWith(recoveryCodePrefix)) return normalisePairingCode(code);
  return code.length === recoveryCodeLength &&
    [...code.slice(recoveryCodePrefix.length)].every((char) =>
      pairingCodeAlphabet.includes(char),
    )
    ? code
    : null;
}

/** The lookup the core finds the invite by, and the secret it checks. */
export function splitInviteCode(code: string) {
  return splitPairingCode(
    code.startsWith(recoveryCodePrefix)
      ? code.slice(recoveryCodePrefix.length)
      : code,
  );
}

/** The code as people read it, in groups of four. */
export function formatInviteCode(code: string) {
  return code.startsWith(recoveryCodePrefix)
    ? (code.match(/.{1,4}/g) ?? []).join("-")
    : formatPairingCode(code);
}

/**
 * The name an invite's code is registered under, which OPAQUE's key for it
 * is derived from. A login's is its username; an invite has none until the
 * person chooses one.
 */
export function inviteIdentifier(inviteId: string) {
  return `invite:${inviteId}`;
}
