// Pairing a shared device: its display code, the QR code it shows whoever
// approves it, and the settings of the OPAQUE exchange that checks the host.
// The core makes the first two characters and the device makes the last
// six. The approving device reads the whole code back.
//
// The code's first characters are its lookup, which the core gives the
// device and uses to find the request. The rest is the device's secret: the
// device draws it, shows it and never sends it. Whoever approves types all
// eight characters on a device the home already trusts. The core runs
// OPAQUE with the shared device. The core knows the secret, and the device
// holds a one-time record of it. Only the real host learns the secret that way, so a
// finished exchange shows that the device reached this home, with no second
// value for anyone to compare.

/**
 * The characters a display code is made of: digits and capitals without
 * look-alikes (no 0, 1, I, L, O or U).
 */
export const pairingCodeAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const pairingCodeLength = 8;
/** The characters of the code the core gives the device. */
export const pairingLookupLength = 2;
/** The characters the device draws itself and never sends. */
export const pairingSecretLength = pairingCodeLength - pairingLookupLength;

/** A request expires this long after it was made, approved or not. */
export const pairingRequestMs = 10 * 60_000;

/**
 * The pairing exchange a device and a core speak: a device asks with it, and
 * a core refuses another.
 */
export const pairingProtocol = 2;

/**
 * OPAQUE's settings for the exchange, the same on both sides, or the
 * exchange fails as if the code were wrong. The record lives minutes in the
 * device's memory, and nothing anyone in between sees lets them test a guess
 * offline, so key stretching stays light enough for a wall display.
 */
export const pairingOpaque = {
  identifiers: {
    client: "sanctum pair core v1",
    server: "sanctum pair device v1",
  },
  // Each code has its own server setup, so one name serves every request.
  userIdentifier: "shared device",
  keyStretching: {
    "argon2id-custom": { iterations: 1, memory: 8192, parallelism: 1 },
  },
} as const;

/**
 * How many exchanges a request allows, counting each one the core starts,
 * so a wrong code, a device that never answers and an interrupted exchange
 * all count.
 */
export const pairingExchangesPerRequest = 3;

/** How long a started exchange waits for the device's answer. */
export const pairingAnswerMs = 30_000;

function randomCode(length: number) {
  const size = pairingCodeAlphabet.length;
  // The largest multiple of the alphabet's size a byte reaches, so every
  // character is equally likely.
  const below = 256 - (256 % size);
  let code = "";
  while (code.length < length) {
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < below && code.length < length) {
        code += pairingCodeAlphabet[byte % size];
      }
    }
  }
  return code;
}

/** A device's new secret, uniformly drawn from the alphabet. */
export function newPairingSecret() {
  return randomCode(pairingSecretLength);
}

/**
 * A typed or scanned code as the core reads it: capitals, without spaces or
 * dashes. None when it cannot be a display code.
 */
export function normalisePairingCode(value: string): string | null {
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== pairingCodeLength) {
    return null;
  }
  return [...code].every((char) => pairingCodeAlphabet.includes(char))
    ? code
    : null;
}

/** The first two characters are the lookup and the last six are the secret. */
export function splitPairingCode(code: string) {
  return {
    lookup: code.slice(0, pairingLookupLength),
    secret: code.slice(pairingLookupLength),
  };
}

/** The code as people read it: `K7QX-M4PD`. */
export function formatPairingCode(code: string) {
  const half = pairingCodeLength / 2;
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/** What a shared device's QR code holds. */
export type PairingQr = { hostId: string; homeId: string; code: string };

const qrScheme = "sanctum-pair:";
// Version 3 dropped the pin, which the exchange checks instead; version 2
// added the home id. Neither earlier version is read.
const qrVersion = "3";

/** The text a shared device's QR code encodes. */
export function pairingQrText(qr: PairingQr) {
  const params = new URLSearchParams({
    v: qrVersion,
    host: qr.hostId,
    home: qr.homeId,
    code: qr.code,
  });
  return `${qrScheme}?${params}`;
}

/** What a scanned QR code holds, or none when it is not a pairing code. */
export function parsePairingQr(text: string): PairingQr | null {
  if (!text.startsWith(`${qrScheme}?`)) {
    return null;
  }
  const params = new URLSearchParams(text.slice(qrScheme.length + 1));
  const hostId = params.get("host");
  const homeId = params.get("home");
  const code = normalisePairingCode(params.get("code") ?? "");
  if (params.get("v") !== qrVersion || !hostId || !homeId || !code) {
    return null;
  }
  return { hostId, homeId, code };
}
