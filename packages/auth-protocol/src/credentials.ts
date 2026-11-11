// The rules for usernames and passwords. The host never sees a password, so
// the apps enforce the password policy; both sides check usernames.

/** Lowercased, 3 to 30 characters: letters, digits, underscores and dots. */
export const usernamePattern = /^[a-z0-9_.]{3,30}$/;

export function normaliseUsername(value: string) {
  return value.trim().toLowerCase();
}

export function isUsername(value: string) {
  return usernamePattern.test(value);
}

export const passwordMinLength = 8;
export const passwordMaxBytes = 256;

export type PasswordProblem = "too_short" | "too_long";

/** The password as it is registered and checked: NFC, never truncated. */
export function normalisePassword(password: string) {
  return password.normalize("NFC");
}

/** At least 8 characters, at most 256 bytes after NFC normalisation. */
export function passwordProblem(password: string): PasswordProblem | null {
  const normalised = normalisePassword(password);
  if ([...normalised].length < passwordMinLength) {
    return "too_short";
  }
  if (new TextEncoder().encode(normalised).length > passwordMaxBytes) {
    return "too_long";
  }
  return null;
}

/**
 * How devices stretch passwords: the OPAQUE library's memory-constrained
 * Argon2id profile (64 MiB, 3 passes, 4 lanes). Each registration record
 * notes the version it was made with.
 */
export const keyStretching = {
  version: 1,
  profile: "memory-constrained",
} as const;
