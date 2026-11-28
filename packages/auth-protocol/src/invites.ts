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
  pairingCodeAlphabet,
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

/** A typed code as the core reads it, or none when it can't be one. */
export const normaliseInviteCode = normalisePairingCode;

/** The lookup the core finds the invite by, and the secret it checks. */
export const splitInviteCode = splitPairingCode;

/** The code as people read it: `K7QX-M4PD`. */
export const formatInviteCode = formatPairingCode;

// A recovery code stands on its own and has more than 77 bits of entropy.
export const recoveryCodeLength = 16;
export const recoveryLookupLength = 64;

export function newRecoveryCode() {
  return randomCode(recoveryCodeLength);
}

export function normaliseRecoveryCode(value: string): string | null {
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  return code.length === recoveryCodeLength &&
    [...code].every((char) => pairingCodeAlphabet.includes(char))
    ? code
    : null;
}

export function formatRecoveryCode(code: string) {
  return code.match(/.{1,4}/g)?.join("-") ?? "";
}

export async function recoveryLookup(code: string) {
  const data = new TextEncoder().encode(`sanctum recovery code:${code}`);
  const subtle = globalThis.crypto?.subtle;
  const digest = subtle
    ? new Uint8Array(await subtle.digest("SHA-256", data))
    : (await import("@noble/hashes/sha256")).sha256(data);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function isRecoveryLookup(lookup: string) {
  return lookup.length === recoveryLookupLength && !/[^a-f0-9]/.test(lookup);
}

export async function inviteCodeProof(value: string) {
  const recovery = normaliseRecoveryCode(value);
  if (recovery) {
    return { lookup: await recoveryLookup(recovery), secret: recovery };
  }
  const code = normaliseInviteCode(value);
  return code ? splitInviteCode(code) : null;
}

/**
 * The name an invite's code is registered under, which OPAQUE's key for it
 * is derived from. A login's is its username; an invite has none until the
 * person chooses one.
 */
export function inviteIdentifier(inviteId: string) {
  return `invite:${inviteId}`;
}
