import { Bonjour } from "bonjour-service";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { z } from "zod";

import { lanInterfaces } from "./announce.js";

// Finding devices on the home's network for the apps that look for them.
// Apps never listen to the network themselves: the manager, which runs on the
// host's network and announces Sanctum there, browses mDNS for the services
// the core asks for, and keeps a sighting of each instance it finds. It asks
// again every minute; one not seen for 10 minutes is lost. A sighting is
// kept only with addresses an app may reach: usable IPv4 unicast addresses on
// the subnet of one of the host's own network interfaces, never that subnet's
// own address or its broadcast, the host's own addresses or a container's.
//
// The manager never calls the core, so the core asks: each answer names this
// run of the manager and a number, and the core asks for what changed after
// it. An answer from another run, or after more changes than are kept, holds
// every sighting afresh. With nothing new, the answer waits up to 30 s.

/** An mDNS service type, such as _example._tcp. */
export const mdnsService =
  /^_[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\._(?:tcp|udp)$/;

// What the core is handed of one instance; the core checks it again, as it
// does all the manager says.
const sightingSchema = z.object({
  service: z.string().regex(mdnsService),
  name: z.string().min(1).max(255),
  host: z.string().min(1).max(255),
  addresses: z.array(z.ipv4()).min(1).max(8),
  port: z.number().int().min(1).max(65_535),
  txt: z
    .record(z.string().min(1).max(64), z.string().max(255))
    .refine((txt) => Object.keys(txt).length <= 64),
});
export type Sighting = z.infer<typeof sightingSchema>;
export type SightingLost = Pick<Sighting, "service" | "name">;

const sightingKey = (sighting: SightingLost) =>
  `${sighting.service}\u0000${sighting.name}`;

const staleMs = 10 * 60_000;
const askEveryMs = 60_000;
const waitMs = 30_000;
const keptChanges = 1_000;
// A burst of answers is taken in once.
const settleMs = 250;

/** What the core hears: what changed after its `after`, or every sighting. */
export type DiscoveryAnswer = {
  after: string;
  full: boolean;
  found: Sighting[];
  lost: SightingLost[];
};

/** A subnet, as an interface's address and mask. */
export type Subnet = { address: string; netmask: string };

/** What the host's own interfaces say of the networks it is on. */
export type HostNetworks = {
  // Its physical interfaces' subnets, where the home's devices are.
  home: Subnet[];
  // Every address of its own, and its virtual interfaces' subnets, such as
  // Docker's bridges.
  own: string[];
  virtual: Subnet[];
};

export function hostNetworks(): HostNetworks {
  const physical = new Set(lanInterfaces());
  const networks: HostNetworks = { home: [], own: [], virtual: [] };
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const each of addresses ?? []) {
      if (each.family !== "IPv4") continue;
      networks.own.push(each.address);
      if (each.internal) continue;
      const subnet = { address: each.address, netmask: each.netmask };
      (physical.has(name) ? networks.home : networks.virtual).push(subnet);
    }
  }
  return networks;
}

const toNumber = (address: string) =>
  address
    .split(".")
    .reduce((number, part) => ((number << 8) >>> 0) + Number(part), 0) >>> 0;

const isIpv4 = (address: string) =>
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(
    address,
  );

const contains = (subnet: Subnet, address: number) => {
  const mask = toNumber(subnet.netmask);
  return (address & mask) >>> 0 === (toNumber(subnet.address) & mask) >>> 0;
};

// 0.0.0.0/8, loopback, link-local, multicast and reserved addresses, the
// limited broadcast among them.
function isSpecial(address: number) {
  const first = address >>> 24;
  const second = (address >>> 16) & 0xff;
  return (
    first === 0 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    first >= 224
  );
}

/** Whether an app may be handed an address: one of a device on the home's own network. */
export function isHomeAddress(address: string, networks: HostNetworks) {
  if (!isIpv4(address)) return false;
  const number = toNumber(address);
  if (isSpecial(number)) return false;
  if (networks.own.includes(address)) return false;
  if (networks.virtual.some((subnet) => contains(subnet, number))) {
    return false;
  }
  return networks.home.some((subnet) => {
    if (!contains(subnet, number)) return false;
    const mask = toNumber(subnet.netmask);
    // Neither the subnet's own address nor its broadcast.
    return (number & ~mask) >>> 0 !== 0 && (number | mask) >>> 0 !== 0xffffffff;
  });
}

/** What mDNS says of one instance, as bonjour-service gives it. */
export type FoundService = {
  lastSeen: number;
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, unknown>;
};

/** Browsing for one service, as bonjour-service's Browser does it. */
export type ServiceBrowser = {
  readonly services: readonly FoundService[];
  on(event: string, listener: () => void): unknown;
  stop(): void;
};

/** What browses: bonjour-service, or a test's own. */
export type Browsing = {
  browse(type: string, protocol: "tcp" | "udp"): ServiceBrowser;
  destroy(): void;
};

function bonjourBrowsing(): Browsing {
  const bonjour = new Bonjour();
  return {
    browse: (type, protocol) =>
      bonjour.find({ type, protocol }) as unknown as ServiceBrowser,
    destroy: () => bonjour.destroy(),
  };
}

// A TXT record's values as text: a key without a value is empty.
function txtOf(txt: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    Object.entries(txt ?? {}).flatMap(([key, value]) =>
      typeof value === "string"
        ? [[key, value]]
        : value === true
          ? [[key, ""]]
          : Buffer.isBuffer(value)
            ? [[key, value.toString("utf8")]]
            : [],
    ),
  );
}

/** A sighting an app may be handed, or none for one with no address it may reach. */
export function sightingOf(
  service: string,
  found: FoundService,
  networks: HostNetworks,
): Sighting | null {
  const addresses = [
    ...new Set(
      (found.addresses ?? []).filter((each) => isHomeAddress(each, networks)),
    ),
  ].sort();
  const parsed = sightingSchema.safeParse({
    service,
    name: found.name,
    host: found.host,
    addresses,
    port: found.port,
    txt: txtOf(found.txt),
  });
  return parsed.success ? parsed.data : null;
}

type Change = {
  seq: number;
  key: string;
  found?: Sighting;
  lost?: SightingLost;
};

export type Discovery = ReturnType<typeof createDiscovery>;

export function createDiscovery(
  options: {
    log?: (message: string) => void;
    browsing?: () => Browsing;
    networks?: () => HostNetworks;
    now?: () => number;
    staleMs?: number;
    askEveryMs?: number;
    waitMs?: number;
  } = {},
) {
  const log = options.log ?? (() => undefined);
  const networks = options.networks ?? hostNetworks;
  const now = options.now ?? Date.now;
  const stale = options.staleMs ?? staleMs;
  const wait = options.waitMs ?? waitMs;
  const run = randomUUID();
  let browsing: Browsing | undefined;
  const browsers = new Map<string, ServiceBrowser>();
  const sightings = new Map<string, { sighting: Sighting; seenAt: number }>();
  let changes: Change[] = [];
  let seq = 0;
  const waiting = new Set<() => void>();
  let settling: NodeJS.Timeout | undefined;
  let closed = false;

  function record(change: Omit<Change, "seq">) {
    seq += 1;
    changes.push({ seq, ...change });
    if (changes.length > keptChanges) changes = changes.slice(-keptChanges);
    for (const wake of [...waiting]) wake();
  }

  // Takes in what the browsers have now: a new or changed sighting is found,
  // and one not seen for a while is lost.
  function take() {
    const at = now();
    const nets = networks();
    // A network change must not leave an address the app may no longer reach.
    for (const [key, kept] of sightings) {
      const sighting = sightingOf(
        kept.sighting.service,
        {
          ...kept.sighting,
          lastSeen: kept.seenAt,
        },
        nets,
      );
      if (!sighting) lose(key);
      else if (JSON.stringify(sighting) !== JSON.stringify(kept.sighting)) {
        kept.sighting = sighting;
        record({ key, found: sighting });
      }
    }
    for (const [service, browser] of browsers) {
      const seen = new Set<string>();
      for (const found of browser.services) {
        if (at - found.lastSeen >= stale) continue;
        const sighting = sightingOf(service, found, nets);
        if (!sighting) {
          if (found.name) lose(sightingKey({ service, name: found.name }));
          continue;
        }
        const key = sightingKey(sighting);
        seen.add(key);
        const kept = sightings.get(key);
        sightings.set(key, { sighting, seenAt: found.lastSeen });
        if (
          !kept ||
          JSON.stringify(kept.sighting) !== JSON.stringify(sighting)
        ) {
          record({ key, found: sighting });
        }
      }
      for (const [key, kept] of sightings) {
        if (kept.sighting.service !== service || seen.has(key)) continue;
        if (at - kept.seenAt >= stale) lose(key);
      }
    }
  }

  function lose(key: string) {
    const kept = sightings.get(key);
    if (!kept) return;
    sightings.delete(key);
    const { service, name } = kept.sighting;
    record({ key, lost: { service, name } });
  }

  const settle = () => {
    if (settling || closed) return;
    settling = setTimeout(() => {
      settling = undefined;
      if (!closed) take();
    }, settleMs);
  };

  function browse(service: string) {
    browsers.get(service)?.stop();
    const [, type, protocol] = /^_(.+)\._(tcp|udp)$/.exec(service)!;
    browsing ??= (options.browsing ?? bonjourBrowsing)();
    const browser = browsing.browse(type!, protocol as "tcp" | "udp");
    for (const event of ["up", "down", "srv-update", "txt-update"]) {
      browser.on(event, settle);
    }
    browsers.set(service, browser);
  }

  // Browses for the services asked for, and only those: one no longer asked
  // for stops, and its sightings are lost.
  function want(services: readonly string[]) {
    for (const [service, browser] of browsers) {
      if (services.includes(service)) continue;
      browser.stop();
      browsers.delete(service);
      for (const [key, kept] of sightings) {
        if (kept.sighting.service === service) lose(key);
      }
      log(`discovery: no longer looking for ${service}`);
    }
    for (const service of services) {
      if (browsers.has(service)) continue;
      browse(service);
      log(`discovery: looking for ${service}`);
    }
  }

  const every = setInterval(() => {
    take();
    // The browser keeps unchanged answers, including their old addresses
    // and timestamp. A fresh browse asks without retaining that cache.
    for (const service of browsers.keys()) browse(service);
  }, options.askEveryMs ?? askEveryMs);
  every.unref();

  function answer(from: number | null): DiscoveryAnswer {
    const after = `${run}:${seq}`;
    if (from === null) {
      return {
        after,
        full: true,
        found: [...sightings.values()].map(({ sighting }) => sighting),
        lost: [],
      };
    }
    // The last of each sighting's changes.
    const last = new Map<string, Change>();
    for (const change of changes) {
      if (change.seq > from) last.set(change.key, change);
    }
    const all = [...last.values()];
    return {
      after,
      full: false,
      found: all.flatMap((change) => change.found ?? []),
      lost: all.flatMap((change) => change.lost ?? []),
    };
  }

  return {
    /**
     * What changed after `after`, which an earlier answer gave, browsing for
     * `services` from now on. Every sighting for an `after` of another run or
     * one too old; with nothing new, it waits up to 30 s for something.
     */
    async poll(after: string | null, services: readonly string[]) {
      want(services);
      const [ofRun, at] = after?.split(":") ?? [];
      const from = Number(at);
      const oldest = changes[0]?.seq ?? seq + 1;
      if (
        ofRun !== run ||
        !Number.isInteger(from) ||
        from > seq ||
        from < oldest - 1
      ) {
        return answer(null);
      }
      if (from === seq) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            waiting.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, wait);
          waiting.add(wake);
        });
        // A burst while it waited may have outrun the changes kept.
        if (from < (changes[0]?.seq ?? seq + 1) - 1) return answer(null);
      }
      return answer(from);
    },

    /** Takes in what the browsers have now, as the minute's round does. */
    take,

    close() {
      closed = true;
      clearInterval(every);
      clearTimeout(settling);
      for (const wake of [...waiting]) wake();
      for (const browser of browsers.values()) browser.stop();
      browsers.clear();
      browsing?.destroy();
    },
  };
}
