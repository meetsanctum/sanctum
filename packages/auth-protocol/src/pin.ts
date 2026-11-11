// The host CA's pin: the SHA-256 hash of the CA's public key, its
// SubjectPublicKeyInfo, base64url-encoded. The core binds sign-ins to it,
// the shells check every connection against it, and a shared device's QR
// code carries it. Pinning the key rather than the certificate lets the CA
// certificate be re-signed without anything re-pinning. Runs on WebCrypto
// alone, in the core, the shells' native layers and the web views.

/** The pin of a public key, from its DER-encoded SubjectPublicKeyInfo. */
export async function spkiPin(spki: Uint8Array<ArrayBuffer>) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", spki);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Whether `value` has a pin's shape: 32 bytes, base64url without padding. */
export function isPin(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
