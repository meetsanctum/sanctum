import type { Sighting } from "@meetsanctum/app-sdk";

// ESPHome's devices as the home's network announces them on mDNS, under
// _esphomelib._tcp: each by its node's name, with its MAC address, its
// friendly name and whether it has an encryption key in its TXT record.
// Everything in a record is a claim: a device's MAC is trusted only once
// the handshake with its own key has succeeded.

export const esphomeService = "_esphomelib._tcp";

/**
 * How a device says it encrypts its connections: with a key it was flashed
 * with; waiting to be given one, over a connection encrypted with no key; or
 * not at all, as a device built without encryption, or one that takes its
 * key only in the clear, which Sanctum never sends one.
 */
export type Encryption = "key" | "waiting" | "none";

/** One of ESPHome's devices as its record announces it. */
export type Announced = {
  /** Its MAC address, as the device's key: aa:bb:cc:dd:ee:ff. */
  mac: string;
  /** Its friendly name, or its node's name when it has none. */
  name: string;
  addresses: string[];
  port: number;
  encryption: Encryption;
  version: string | null;
};

/** A MAC address in the form a device's key has, or null for anything else. */
export function macOf(text: string | undefined): string | null {
  const hex = (text ?? "").toLowerCase().replace(/[:-]/g, "");
  return /^[0-9a-f]{12}$/.test(hex) ? hex.match(/../g)!.join(":") : null;
}

/** A sighting as one of ESPHome's devices, or null for one that names no MAC. */
export function announcedOf(sighting: Sighting): Announced | null {
  const mac = macOf(sighting.txt.mac);
  if (!mac) return null;
  const txt = sighting.txt;
  const encryption: Encryption =
    txt.api_encryption !== undefined
      ? "key"
      : txt.api_encryption_supported !== undefined &&
          txt.api_provisioning !== undefined
        ? "waiting"
        : "none";
  return {
    mac,
    name: txt.friendly_name?.trim() || sighting.name,
    addresses: sighting.addresses,
    port: sighting.port,
    encryption,
    version: txt.version?.trim() || null,
  };
}
