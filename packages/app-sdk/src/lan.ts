import { discoveredServices } from "./discovery.js";

// Reaching devices on the home's network. An app never has the network to
// itself: one that holds lan:tcp: permissions gets a network of its own whose
// rules let it open connections only to the addresses found for it
// (discovery.ts), on its ports, and nothing else, not the internet, the host
// or other containers. It hears of an address only once its rules let it
// through, and one taken away is shut before Sanctum says so.
//
// A permission names one port, lan:tcp:6053, or a range, lan:tcp:49152-65535,
// for devices that hand out a port for each session. A range lies within the
// ports devices hand out that way, so it never takes in the well-known and
// registered ports a device's other services listen on, such as SSH or an
// admin page.

const lanPrefix = "lan:tcp:";

/** The ports a range may cover: those devices hand out for a session. */
export const lanRangePorts = { from: 49_152, to: 65_535 } as const;

/** The most lan:tcp: permissions an app may ask for; a range counts as one. */
export const maxLanPermissions = 16;

/** The ports one lan:tcp: permission names, both ends included. */
export type LanRange = { from: number; to: number };

/** The permission to reach the devices an app found, on one TCP port. */
export const lanPermission = (port: number) => `${lanPrefix}${port}`;

/** The permission to reach the devices an app found, on a range of TCP ports. */
export const lanRangePermission = (from: number, to: number) =>
  `${lanPrefix}${from}-${to}`;

const portOf = (text: string) => {
  if (!/^[1-9][0-9]{0,4}$/.test(text)) return null;
  const port = Number(text);
  return port <= 65_535 ? port : null;
};

/**
 * The ports a lan:tcp: permission names, or null for any other permission and
 * for one that names no port or range it can: a range runs upwards, within
 * the ports devices hand out for a session.
 */
export function lanRange(permission: string): LanRange | null {
  if (!permission.startsWith(lanPrefix)) return null;
  const [first, second, ...rest] = permission
    .slice(lanPrefix.length)
    .split("-");
  if (rest.length > 0) return null;
  const from = portOf(first ?? "");
  if (from === null) return null;
  if (second === undefined) return { from, to: from };
  const to = portOf(second);
  if (
    to === null ||
    to <= from ||
    from < lanRangePorts.from ||
    to > lanRangePorts.to
  ) {
    return null;
  }
  return { from, to };
}

/** The port a single-port permission names, or null for any other one. */
export function lanPort(permission: string): number | null {
  const range = lanRange(permission);
  return range && range.from === range.to ? range.from : null;
}

/** The single ports a set of permissions names, in order. */
export const lanPorts = (permissions: readonly string[]) =>
  [...new Set(permissions.flatMap((each) => lanPort(each) ?? []))].sort(
    (a, b) => a - b,
  );

/** Whether a permission id is a lan: one that names no port or range it can. */
export const isMalformedLan = (permission: string) =>
  permission.startsWith("lan:") && lanRange(permission) === null;

/** The ports a set of permissions names, one range per permission, in order. */
export const lanRanges = (permissions: readonly string[]) =>
  [...new Set(permissions)]
    .flatMap((each) => lanRange(each) ?? [])
    .sort((a, b) => a.from - b.from || a.to - b.to);

/**
 * The ports as few ranges as cover them, in order, ranges that overlap or
 * touch joined: what they let through, whichever way it was written.
 */
export function mergedLanRanges(ranges: readonly LanRange[]): LanRange[] {
  const merged: LanRange[] = [];
  for (const { from, to } of [...ranges].sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else merged.push({ from, to });
  }
  return merged;
}

/** Whether every port of `inner` is one of `outer`'s. */
export function lanRangesWithin(
  inner: readonly LanRange[],
  outer: readonly LanRange[],
) {
  const covering = mergedLanRanges(outer);
  return inner.every(({ from, to }) =>
    covering.some((each) => each.from <= from && to <= each.to),
  );
}

/**
 * Checks an app's lan:tcp: permissions, as its definition and the core
 * reading its manifest both do: each names a port or a range it can, no more
 * than 16 of them, no two share a port, so switching one off always takes
 * its ports away, and the app finds the devices it reaches.
 */
export function assertLanPermissions(
  asked: readonly string[],
  { limitCount = true }: { limitCount?: boolean } = {},
) {
  const malformed = asked.find(isMalformedLan);
  if (malformed) {
    throw new Error(
      `${malformed} must name a TCP port, such as lan:tcp:6053, or a range of ports from ${lanRangePorts.from} to ${lanRangePorts.to}, such as lan:tcp:${lanRangePorts.from}-${lanRangePorts.to}`,
    );
  }
  const ids = [...new Set(asked.filter((each) => lanRange(each) !== null))];
  if (ids.length === 0) return;
  if (limitCount && ids.length > maxLanPermissions) {
    throw new Error(
      `An app asks for at most ${maxLanPermissions} lan:tcp: permissions`,
    );
  }
  const ranges = ids
    .map((id) => ({ id, ...lanRange(id)! }))
    .sort((a, b) => a.from - b.from);
  for (const [index, range] of ranges.entries()) {
    const next = ranges[index + 1];
    if (next && next.from <= range.to) {
      throw new Error(`${range.id} and ${next.id} share ports`);
    }
  }
  if (discoveredServices(asked).length === 0) {
    throw new Error(
      "A lan:tcp: permission reaches only devices the app finds, so it needs a discover:mdns: permission too",
    );
  }
}
