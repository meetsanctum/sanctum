import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  ManagerRefusal,
  ManagerUnavailable,
  type Channel,
  type HostHistory,
  type HostStatus,
} from "../manager.js";
import { relay } from "./errors.js";

// Settings → Status: what the host is and how it is doing, for every client.
// The manager reports the host; the core adds what only it knows, the space
// its own data and each app's take, and works out what needs someone, the
// one rule Settings' Needs attention and the dashboard's Attention tile
// share.

export type StatusManager = {
  hostStatus(): Promise<HostStatus>;
  hostHistory(): Promise<HostHistory>;
};

// What needs someone, the most pressing first.
export type HostProblem =
  // The supply was too weak in the last day.
  | { kind: "power"; lastLowAt: string }
  // Less free than an update needs.
  | { kind: "storage"; free: number }
  // Hot enough for a Pi to slow itself down.
  | { kind: "heat"; celsius: number }
  // Almost no memory left, with swap in use.
  | { kind: "memory"; available: number; total: number }
  | {
      kind: "service";
      service: string;
      state: "failed" | "waiting";
      problem: string | null;
      apps: string[];
    }
  // The host's clock is not synchronised: devices may refuse the core's
  // certificate until it is.
  | { kind: "clock" }
  // An app runs apart with nothing to hold it to its memory.
  | { kind: "memoryLimits" }
  // An app's image is gone, or failed its check and was set aside.
  | { kind: "appData"; app: string; state: "missing" | "damaged" };

export type StoragePart =
  | { kind: "devBuilds" | "software" | "system"; bytes: number }
  // The core's own data and the manager's backups of it.
  | { kind: "home"; bytes: number; data: number; backups: number }
  // An app's database and its services' data.
  | { kind: "app"; app: string; bytes: number };

export type MemoryPart =
  | { kind: "core" | "manager" | "devBuilds" | "system"; bytes: number }
  // What runs in its own container, and its share of the services it uses.
  | { kind: "app"; app: string; bytes: number; services: string[] }
  // One no installed app uses, or that an older manager doesn't say.
  | { kind: "service"; service: string; bytes: number };

export type SystemStatus = {
  checkedAt: string;
  version: string;
  // Null, with the host, while the manager doesn't answer.
  channel: Channel | null;
  host: {
    model: string | null;
    os: string | null;
    bits: 32 | 64 | null;
    uptimeSeconds: number | null;
    hostname: string | null;
    memory: {
      total: number;
      available: number;
      swapTotal: number;
      swapUsed: number;
      parts: MemoryPart[];
    } | null;
    storage: { total: number; free: number; parts: StoragePart[] } | null;
    processor: HostStatus["processor"];
    power: HostStatus["power"];
    network: HostStatus["network"];
    clock: boolean | null;
  } | null;
  problems: HostProblem[];
};

// What an update needs free: the new images, and a copy of the home's data.
export const storageFloor = 1.5e9;
// Where a Raspberry Pi starts slowing itself down.
export const hotCelsius = 80;
const lowMemoryShare = 0.05;
const powerForMs = 24 * 60 * 60_000;

const bitsOf = (architecture: string | null) =>
  architecture === null
    ? null
    : /64/.test(architecture)
      ? 64
      : /^(arm|i[3-6]86)/.test(architecture)
        ? 32
        : null;

// The space each of the core's files takes: an app's database (with its
// journal) under apps/ is that app's; everything else is the home's.
async function dataSizes(dataDir: string, appIds: readonly string[]) {
  const apps = new Map<string, number>();
  let home = 0;
  const entries = await readdir(dataDir, {
    withFileTypes: true,
    recursive: true,
  }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const size = (await lstat(path).catch(() => null))?.size ?? 0;
    const app =
      entry.parentPath === join(dataDir, "apps")
        ? /^(.+)\.db(-wal|-shm)?$/.exec(entry.name)?.[1]
        : undefined;
    if (app && appIds.includes(app)) {
      apps.set(app, (apps.get(app) ?? 0) + size);
    } else {
      home += size;
    }
  }
  return { home, apps };
}

export function problemsOf(host: HostStatus, now: Date): HostProblem[] {
  const problems: HostProblem[] = [];
  const lastLowAt = host.power?.lastLowAt;
  if (lastLowAt && now.getTime() - Date.parse(lastLowAt) < powerForMs) {
    problems.push({ kind: "power", lastLowAt });
  }
  if (host.storage && host.storage.free < storageFloor) {
    problems.push({ kind: "storage", free: host.storage.free });
  }
  const { celsius } = host.processor;
  if (celsius !== null && celsius >= hotCelsius) {
    problems.push({ kind: "heat", celsius });
  }
  const memory = host.memory;
  if (
    memory &&
    memory.available < memory.total * lowMemoryShare &&
    memory.swapTotal - memory.swapFree > 0
  ) {
    problems.push({
      kind: "memory",
      available: memory.available,
      total: memory.total,
    });
  }
  for (const service of host.services) {
    if (service.state === "failed" || service.state === "waiting") {
      problems.push({
        kind: "service",
        service: service.name,
        state: service.state,
        problem: service.problem ?? null,
        apps: service.apps,
      });
    }
  }
  if (host.clock === false) problems.push({ kind: "clock" });
  for (const image of host.storage?.images ?? []) {
    if (image.state !== "ok") {
      problems.push({ kind: "appData", app: image.app, state: image.state });
    }
  }
  if (
    host.memoryLimits === false &&
    memory?.containers.some((container) => container.role === "app")
  ) {
    problems.push({ kind: "memoryLimits" });
  }
  return problems;
}

function memoryParts(
  memory: NonNullable<HostStatus["memory"]>,
  appIds: readonly string[],
) {
  const others = new Map<string, MemoryPart>();
  const apps = new Map<string, Extract<MemoryPart, { kind: "app" }>>();
  const addTo = (key: string, part: MemoryPart) => {
    const same = others.get(key);
    if (same) same.bytes += part.bytes;
    else others.set(key, part);
  };
  const addToApp = (app: string, bytes: number, service?: string) => {
    const part = apps.get(app) ?? { kind: "app", app, bytes: 0, services: [] };
    part.bytes += bytes;
    if (service) part.services = [...part.services, service].sort();
    apps.set(app, part);
  };
  let counted = 0;
  for (const container of memory.containers) {
    const { bytes, role } = container;
    if (role === "app") {
      // One that's no longer installed is left to the system's part.
      if (!container.app || !appIds.includes(container.app)) continue;
      addToApp(container.app, bytes);
    } else if (role === "service") {
      const service = container.service ?? "";
      const users = (container.apps ?? []).filter((app) =>
        appIds.includes(app),
      );
      // A service's memory is its apps', shared between them, as its data is.
      for (const app of users) {
        addToApp(app, Math.round(bytes / users.length), service);
      }
      if (users.length === 0) {
        addTo(service, { kind: "service", service, bytes });
      }
    } else {
      const kind = role === "registry" ? "devBuilds" : role;
      addTo(kind, { kind, bytes });
    }
    counted += bytes;
  }
  const used = memory.total - memory.available;
  return [
    ...others.values(),
    ...apps.values(),
    { kind: "system" as const, bytes: Math.max(0, used - counted) },
  ];
}

function storageParts(
  storage: NonNullable<HostStatus["storage"]>,
  data: { home: number; apps: Map<string, number> },
  appIds: readonly string[],
) {
  const apps = new Map(data.apps);
  // An app's image is its own.
  for (const image of storage.images ?? []) {
    if (appIds.includes(image.app)) {
      apps.set(image.app, (apps.get(image.app) ?? 0) + image.bytes);
    }
  }
  // A service's data is its apps', shared between them.
  for (const service of storage.services) {
    for (const app of service.apps) {
      if (!apps.has(app)) continue;
      apps.set(
        app,
        apps.get(app)! + Math.round(service.bytes / service.apps.length),
      );
    }
  }
  const backups = storage.backups ?? 0;
  const parts: StoragePart[] = [
    ...(storage.devBuilds === null
      ? []
      : [{ kind: "devBuilds" as const, bytes: storage.devBuilds }]),
    ...(storage.software === null
      ? []
      : [{ kind: "software" as const, bytes: storage.software }]),
    { kind: "home", bytes: data.home + backups, data: data.home, backups },
    ...[...apps].map(([app, bytes]) => ({ kind: "app" as const, app, bytes })),
  ];
  const counted = parts.reduce((sum, part) => sum + part.bytes, 0);
  parts.push({
    kind: "system",
    bytes: Math.max(0, storage.total - storage.free - counted),
  });
  return parts;
}

export function createStatus(options: {
  manager: StatusManager;
  dataDir: string;
  // The core's own version.
  version: string;
  // The apps installed now, whose databases are theirs.
  appIds: () => readonly string[];
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());

  return {
    async status(): Promise<SystemStatus> {
      const checkedAt = now();
      let host: HostStatus;
      try {
        host = await options.manager.hostStatus();
      } catch (error) {
        if (
          error instanceof ManagerUnavailable ||
          error instanceof ManagerRefusal
        ) {
          return {
            checkedAt: checkedAt.toISOString(),
            version: options.version,
            channel: null,
            host: null,
            problems: [],
          };
        }
        throw error;
      }
      const appIds = options.appIds();
      const data = await dataSizes(options.dataDir, appIds);
      return {
        checkedAt: checkedAt.toISOString(),
        version: options.version,
        channel: host.channel,
        host: {
          model: host.model,
          os: host.os,
          bits: bitsOf(host.architecture),
          uptimeSeconds: host.uptimeSeconds,
          hostname: host.hostname,
          memory: host.memory && {
            total: host.memory.total,
            available: host.memory.available,
            swapTotal: host.memory.swapTotal,
            swapUsed: host.memory.swapTotal - host.memory.swapFree,
            parts: memoryParts(host.memory, appIds),
          },
          storage: host.storage && {
            total: host.storage.total,
            free: host.storage.free,
            parts: storageParts(host.storage, data, appIds),
          },
          processor: host.processor,
          power: host.power,
          network: host.network,
          clock: host.clock,
        },
        problems: problemsOf(host, checkedAt),
      };
    },

    // The host's last 24 hours, as the manager keeps them.
    history: () => relay(() => options.manager.hostHistory()),
  };
}

export type Status = ReturnType<typeof createStatus>;
