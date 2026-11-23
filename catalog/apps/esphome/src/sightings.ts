import type { Sighting } from "@meetsanctum/app-sdk";

// ESPHome's devices as the home's network announces them on mDNS, under
// _esphomelib._tcp: each by its node's name, with its MAC address, its
// friendly name and whether it has an encryption key in its TXT record.
// Everything in a record is a claim: a device's MAC is trusted only once
// the handshake with its own key has succeeded.

export const esphomeService = "_esphomelib._tcp";

/**
 * How a device says it encrypts its connections, as it booted: with a key;
 * waiting to be given one, over a connection encrypted with no key; able to
 * take one with no way to wait for it, as firmware before ESPHome 2026.7,
 * which takes a first key only in the clear; or not at all, as a device
 * built without encryption. Only a first guess: a device writes its record
 * as it boots, so a key given or taken off since leaves it stale.
 */
export type Encryption = "key" | "waiting" | "older" | "none";

/**
 * Whether an ESPHome version is from before 2026.7, the first that waits
 * for a key under the zero key; null for one that says no version.
 */
export function beforeProvisioning(version: string | null | undefined) {
  const parts = /^(\d+)\.(\d+)(?:\.\d+(?:b\d+|[-+][\w.+-]+)?)?$/.exec(
    version?.trim() ?? "",
  );
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  return year < 2026 || (year === 2026 && month < 7);
}

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
  projectName: string | null;
};

/** A MAC address in the form a device's key has, or null for anything else. */
export function macOf(text: string | undefined): string | null {
  const hex = (text ?? "").toLowerCase().replace(/[:-]/g, "");
  return /^[0-9a-f]{12}$/.test(hex) ? hex.match(/../g)!.join(":") : null;
}

/**
 * A device's name without the end of its MAC address that ESPHome adds to
 * set apart devices on the same firmware (name_add_mac_suffix): "Home
 * Assistant Voice 0ad8d8" is "Home Assistant Voice". A name that is nothing
 * else stays whole.
 */
export function withoutMacSuffix(name: string, mac: string) {
  const trimmed = name.trim();
  const suffix = trimmed.match(/[ _-]([0-9a-f]{6})$/i)?.[1]?.toLowerCase();
  if (suffix !== mac.replaceAll(":", "").slice(-6)) return trimmed;
  return trimmed.slice(0, -7).trimEnd() || trimmed;
}

/** A sighting as one of ESPHome's devices, or null for one that names no MAC. */
export function announcedOf(sighting: Sighting): Announced | null {
  const mac = macOf(sighting.txt.mac);
  if (!mac) return null;
  const txt = sighting.txt;
  const encryption: Encryption =
    txt.api_encryption !== undefined
      ? "key"
      : txt.api_encryption_supported === undefined
        ? "none"
        : txt.api_provisioning !== undefined
          ? "waiting"
          : "older";
  return {
    mac,
    name: withoutMacSuffix(txt.friendly_name?.trim() || sighting.name, mac),
    addresses: sighting.addresses,
    port: sighting.port,
    encryption,
    version: txt.version?.trim() || null,
    projectName: txt.project_name?.trim() || null,
  };
}
