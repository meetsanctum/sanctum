import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { appLabel, appRole } from "../apps/containers.js";
import type { ImageStatus } from "../apps/images.js";
import type { Channel } from "../config.js";
import { coreRole } from "../core-container.js";
import {
  errorMessage,
  memoryOf,
  roleLabel,
  type StatusDockerLike,
} from "../docker.js";
import { serviceDefinitions } from "../services/registry.js";
import type { ServiceStatus } from "../services/services.js";
import { updaterRole } from "../update/manager-update.js";
import type { HostHistory } from "./history.js";
import {
  usageBetween,
  type CpuTimes,
  type HostReadings,
  type MemoryReading,
  type NetworkReading,
} from "./readings.js";
import { isOurs, stacked } from "../stack.js";

// The host's status for Settings → Status, on the manager's socket as
// GET /api/host/status. The core adds its own data and works out what needs
// someone; the manager only reports.
//
// The processor's load and a Pi's power alarm are sampled every 10 seconds,
// so the load is over the last ones and a dip in power between two looks is
// remembered (until the manager restarts). Each sample, with the temperature
// and the memory in use, also goes into the host's day (history.ts). What
// images and volumes take is slow to count, so it is kept for 10 minutes,
// until something frees space.

// What runs in one of Sanctum's containers: the core with the apps still in it,
// an app of its own, the manager (and its updater), a service, or the dev
// channel's registry.
export type ContainerMemory = {
  role: "core" | "app" | "manager" | "service" | "registry";
  service?: string;
  // The apps a service is for.
  apps?: string[];
  app?: string;
  bytes: number;
};

// The space a service's data volume takes, for the apps it serves.
export type ServiceStorage = { service: string; apps: string[]; bytes: number };

export type HostStatus = {
  channel: Channel;
  model: string | null;
  os: string | null;
  architecture: string | null;
  uptimeSeconds: number | null;
  hostname: string | null;
  // Whether Docker can hold a container to its memory; null if it doesn't say.
  memoryLimits: boolean | null;
  memory: (MemoryReading & { containers: ContainerMemory[] }) | null;
  storage: {
    total: number;
    free: number;
    // Every image's layers, counted once.
    software: number | null;
    // The dev channel's registry volume; null on other hosts.
    devBuilds: number | null;
    // The core's data copied before each update.
    backups: number | null;
    services: ServiceStorage[];
    // Each app's image with its data.
    images: ImageStatus[];
  } | null;
  processor: {
    cores: number;
    // From 0 to 1, over the last sample.
    usage: number | null;
    mhz: number | null;
    celsius: number | null;
  };
  // A Raspberry Pi's supply: low now, and when it was last seen low.
  power: { low: boolean; lastLowAt: string | null } | null;
  network: NetworkReading | null;
  clock: boolean | null;
  services: ServiceStatus[];
};

const registryVolume = stacked("sanctum-registry-data");
const sampleEveryMs = 10_000;
const sizesForMs = 10 * 60_000;

// The space a folder's files take, its folders' included. A file with several
// names counts once, as the apps' packages share what they have in common.
export async function folderSize(folder: string): Promise<number | null> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true, recursive: true });
  } catch {
    return null;
  }
  let bytes = 0;
  const counted = new Set<number>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stats = await lstat(join(entry.parentPath, entry.name)).catch(
      () => null,
    );
    if (!stats || counted.has(stats.ino)) continue;
    if (stats.nlink > 1) counted.add(stats.ino);
    bytes += stats.size;
  }
  return bytes;
}

// The apps a service is for: those that asked for it, and those of the
// services that need it, as Zigbee's bridge needs the broker.
function appsOf(name: string, services: readonly ServiceStatus[]) {
  const apps = new Set(
    services.find((service) => service.name === name)?.apps ?? [],
  );
  for (const definition of serviceDefinitions) {
    if (!definition.needs.includes(name)) continue;
    for (const app of appsOf(definition.name, services)) apps.add(app);
  }
  return [...apps].sort();
}

// Which of Sanctum's containers this is, by the labels the manager and
// Compose give them; anything else on the host is the system's.
function roleOf(container: {
  Names?: string[];
  Labels?: Record<string, string> | null;
}): Omit<ContainerMemory, "bytes"> | null {
  const labels = container.Labels ?? {};
  if (!isOurs(labels)) return null;
  const role = labels[roleLabel];
  if (role === coreRole) return { role: "core" };
  if (role === appRole && labels[appLabel]) {
    return { role: "app", app: labels[appLabel] };
  }
  if (role === updaterRole) return { role: "manager" };
  if (role && serviceDefinitions.some((each) => each.name === role)) {
    return { role: "service", service: role };
  }
  if (labels["com.docker.compose.project"] === stacked("sanctum")) {
    const service = labels["com.docker.compose.service"];
    if (service === "manager") return { role: "manager" };
    if (service === "registry") return { role: "registry" };
  }
  return null;
}

export function createHostStatus(options: {
  readings: HostReadings;
  // Absent when the manager supervises no host.
  docker?: StatusDockerLike;
  services?: { list: () => ServiceStatus[] };
  images?: { listOrNone: () => Promise<ImageStatus[]> };
  dataDir: string;
  channel: Channel;
  clock: () => Promise<boolean | null>;
  // The host's day, which each sample adds to.
  history?: Pick<HostHistory, "add">;
  log: (message: string) => void;
  now?: () => Date;
}) {
  const { readings, docker, dataDir, log } = options;
  const now = options.now ?? (() => new Date());
  let lastTimes: CpuTimes | null = null;
  let usage: number | null = null;
  let low: boolean | null = null;
  let lastLowAt: Date | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let system:
    | Pick<HostStatus, "os" | "architecture" | "hostname" | "memoryLimits">
    | undefined;

  async function sample() {
    const times = await readings.cpuTimes();
    const measured = times && lastTimes ? usageBetween(lastTimes, times) : null;
    if (measured !== null) usage = measured;
    if (times) lastTimes = times;
    low = await readings.lowVoltage();
    if (low) lastLowAt = now();
    if (options.history) {
      const [celsius, memory] = await Promise.all([
        readings.celsius(),
        readings.memory(),
      ]);
      options.history.add({
        usage: measured,
        celsius,
        memoryUsed: memory && memory.total - memory.available,
      });
    }
  }

  type Sizes = Pick<
    NonNullable<HostStatus["storage"]>,
    "software" | "devBuilds" | "backups"
  > & { volumes: Map<string, number> };
  let sizes: { at: number; value: Sizes } | undefined;
  let counting: Promise<Sizes> | undefined;

  async function count(): Promise<Sizes> {
    const backups = await folderSize(join(dataDir, "backups"));
    if (!docker) {
      return { software: null, devBuilds: null, backups, volumes: new Map() };
    }
    const df = await docker.df();
    // The apps' packages are this version and the one before, as the images are.
    const packages = await folderSize(join(dataDir, "packages"));
    const volumes = new Map<string, number>();
    for (const volume of df.Volumes ?? []) {
      const bytes = volume.UsageData?.Size;
      // Docker uses -1 when a volume driver cannot report its size.
      if (bytes !== undefined && bytes >= 0) volumes.set(volume.Name, bytes);
    }
    return {
      software:
        df.LayersSize === undefined ? null : df.LayersSize + (packages ?? 0),
      devBuilds: volumes.get(registryVolume) ?? null,
      backups,
      volumes,
    };
  }

  // The sizes counted in the last 10 minutes, or counted now the first time;
  // older ones are counted again meanwhile.
  async function currentSizes() {
    const fresh = sizes && now().getTime() - sizes.at < sizesForMs;
    if (!fresh && !counting) {
      counting = count()
        .then((value) => {
          sizes = { at: now().getTime(), value };
          return value;
        })
        .catch((error: unknown) => {
          log(`Could not count what takes the space: ${errorMessage(error)}`);
          throw error;
        })
        .finally(() => (counting = undefined));
      // Its failure is reported once, by whoever waits for it.
      counting.catch(() => undefined);
    }
    if (sizes) return sizes.value;
    return counting!.catch(() => null);
  }

  async function containersMemory(
    services: readonly ServiceStatus[],
  ): Promise<ContainerMemory[]> {
    if (!docker) return [];
    const containers = await docker.listContainers();
    const memory = await Promise.all(
      containers.map(async (container): Promise<ContainerMemory | null> => {
        const role = roleOf(container);
        if (!role) return null;
        const bytes = await memoryOf(docker.getContainer(container.Id));
        if (bytes === null) return null;
        return {
          ...role,
          ...(role.service ? { apps: appsOf(role.service, services) } : {}),
          bytes,
        };
      }),
    );
    return memory.filter((each) => each !== null);
  }

  // The host's system as Docker sees it: the manager's own container runs
  // Alpine, whatever the host does, and has its own hostname even on the
  // host's network. Use the host's short name for its .local address.
  async function hostSystem() {
    if (system) return system;
    if (!docker) {
      return {
        os: null,
        architecture: null,
        hostname: readings.hostname().split(".")[0] || null,
        memoryLimits: null,
      };
    }
    const info = await docker.info().catch(() => null);
    if (!info) {
      return {
        os: null,
        architecture: null,
        hostname: null,
        memoryLimits: null,
      };
    }
    system = {
      os: info.OperatingSystem ?? null,
      architecture: info.Architecture ?? null,
      hostname: info.Name?.split(".")[0] || null,
      memoryLimits:
        info.MemoryLimit === undefined
          ? null
          : info.MemoryLimit && info.SwapLimit !== false,
    };
    return system;
  }

  return {
    start() {
      void sample();
      timer = setInterval(() => void sample(), sampleEveryMs);
      timer.unref();
    },

    stop() {
      clearInterval(timer);
    },

    sample,

    // Counts what takes the space again at the next look, once something
    // has freed some.
    recount() {
      sizes = undefined;
    },

    async status(): Promise<HostStatus> {
      const services = options.services?.list() ?? [];
      const [
        model,
        os,
        uptimeSeconds,
        memory,
        containers,
        disk,
        counted,
        mhz,
        celsius,
        network,
        clock,
      ] = await Promise.all([
        readings.model(),
        hostSystem(),
        readings.uptimeSeconds(),
        readings.memory(),
        containersMemory(services).catch(() => []),
        readings.disk(dataDir),
        currentSizes(),
        readings.mhz(),
        readings.celsius(),
        readings.network(),
        options.clock(),
      ]);
      const images = (await options.images?.listOrNone()) ?? [];
      return {
        channel: options.channel,
        model,
        os: os.os,
        architecture: os.architecture,
        uptimeSeconds,
        hostname: os.hostname,
        memoryLimits: os.memoryLimits,
        memory: memory && { ...memory, containers },
        storage: disk && {
          ...disk,
          software: counted?.software ?? null,
          devBuilds: counted?.devBuilds ?? null,
          backups: counted?.backups ?? null,
          images,
          // Each service keeps its data in sanctum-<name>-data.
          services: serviceDefinitions.flatMap(({ name }) => {
            const bytes = counted?.volumes.get(stacked(`sanctum-${name}-data`));
            return bytes === undefined
              ? []
              : [{ service: name, apps: appsOf(name, services), bytes }];
          }),
        },
        processor: { cores: readings.cores(), usage, mhz, celsius },
        power:
          low === null
            ? null
            : { low, lastLowAt: lastLowAt?.toISOString() ?? null },
        network,
        clock,
        services,
      };
    },
  };
}

export type HostStatusReporter = ReturnType<typeof createHostStatus>;
