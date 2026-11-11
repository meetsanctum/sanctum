// Pairing a shared device: its display code, the QR code it shows whoever
// approves it, and the short form of the host's pin people compare. The core
// makes codes; the device shows them and the approving device reads them
// back, so both sides share these rules.

import { isPin } from "./pin.js";

/**
 * The characters a display code is made of: digits and capitals without
 * look-alikes (no 0, 1, I, L, O or U).
 */
export const pairingCodeAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const pairingCodeLength = 8;

/** A request expires this long after it was made, approved or not. */
export const pairingRequestMs = 10 * 60_000;

/** A new display code, uniformly drawn from the alphabet. */
export function newPairingCode() {
  const size = pairingCodeAlphabet.length;
  // The largest multiple of the alphabet's size a byte reaches, so every
  // character is equally likely.
  const below = 256 - (256 % size);
  let code = "";
  while (code.length < pairingCodeLength) {
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < below && code.length < pairingCodeLength) {
        code += pairingCodeAlphabet[byte % size];
      }
    }
  }
  return code;
}

/**
 * A typed or scanned code as the core stores it: capitals, without spaces
 * or dashes. None when it cannot be a display code.
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

/** The code as people read it: `K7QX-M4PD`. */
export function formatPairingCode(code: string) {
  const half = pairingCodeLength / 2;
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/**
 * The short form of a pin people compare by eye: its first 80 bits in five
 * groups, such as `860E-A699-0C71-92C9-1541`.
 */
export function shortPin(pin: string) {
  const base64 = pin.replace(/-/g, "+").replace(/_/g, "/");
  const hex = [...atob(base64).slice(0, 10)]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return hex.match(/.{4}/g)!.join("-");
}

/** What a shared device's QR code holds. */
export type PairingQr = {
  hostId: string;
  homeId: string;
  code: string;
  /** The pin of the certificate the device sees; none over plain HTTP. */
  pin: string | null;
};

const qrScheme = "sanctum-pair:";
// Version 2 added the home id; version 1 is no longer read.
const qrVersion = "2";

/** The text a shared device's QR code encodes. */
export function pairingQrText(qr: PairingQr) {
  const params = new URLSearchParams({
    v: qrVersion,
    host: qr.hostId,
    home: qr.homeId,
    code: qr.code,
  });
  if (qr.pin) {
    params.set("pin", qr.pin);
  }
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
  const pin = params.get("pin");
  if (
    params.get("v") !== qrVersion ||
    !hostId ||
    !homeId ||
    !code ||
    (pin !== null && !isPin(pin))
  ) {
    return null;
  }
  return { hostId, homeId, code, pin };
}
