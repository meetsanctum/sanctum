import { z } from "zod";

// Finding devices on the home's network. An app never listens to the network
// itself: it asks for discover:mdns:<service>, the manager browses for that
// service on the host's network, and the core hands the app what it finds
// (driver.discovered): every current sighting as the app starts, then each
// one found, changed or lost. A sighting not seen for 10 minutes is lost.
// Only addresses on the home's own network reach an app, never the host's
// own or a container's.

/** An mDNS service type, such as _example._tcp. */
export const mdnsService =
  /^_[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\._(?:tcp|udp)$/;

const discoverPrefix = "discover:mdns:";

/** The permission to hear of one service on the home's network. */
export const discoverPermission = (service: string) =>
  `${discoverPrefix}${service}`;

/** The service a discover:mdns: permission names, or null for any other permission. */
export function discoveredService(permission: string) {
  if (!permission.startsWith(discoverPrefix)) return null;
  const service = permission.slice(discoverPrefix.length);
  return mdnsService.test(service) ? service : null;
}

/** Whether a permission id is a discover: one that names no service it can. */
export const isMalformedDiscover = (permission: string) =>
  permission.startsWith("discover:") && discoveredService(permission) === null;

/** The services a set of permissions lets an app hear of. */
export const discoveredServices = (permissions: readonly string[]) => [
  ...new Set(permissions.flatMap((each) => discoveredService(each) ?? [])),
];

const text = (max: number) => z.string().min(1).max(max);

/** One instance of a service the manager found, as an app hears of it. */
export const sightingSchema = z.object({
  /** The service it announces, such as _example._tcp. */
  service: z.string().regex(mdnsService),
  /** Its instance's name, which tells it from others of the service. */
  name: text(255),
  /** The name it announces for its host, such as kitchen.local. */
  host: text(255),
  /** Its IPv4 addresses on the home's network, at least one. */
  addresses: z.array(z.ipv4()).min(1).max(8),
  port: z.number().int().min(1).max(65_535),
  /** Its TXT record, every value as text. */
  txt: z
    .record(z.string().min(1).max(64), z.string().max(255))
    .refine((txt) => Object.keys(txt).length <= 64, "at most 64 entries"),
});
export type Sighting = z.infer<typeof sightingSchema>;

/** A sighting that has gone, by its service and name. */
export const sightingLostSchema = z.object({
  service: z.string().regex(mdnsService),
  name: text(255),
});
export type SightingLost = z.infer<typeof sightingLostSchema>;

/**
 * What changed among the sightings of the services a driver hears of: those
 * new or changed since it last heard, and those gone (driver.discovered).
 */
export type DriverDiscovery = { found: Sighting[]; lost: SightingLost[] };

/** A sighting's key among all of them. */
export const sightingKey = (sighting: { service: string; name: string }) =>
  `${sighting.service}\u0000${sighting.name}`;
