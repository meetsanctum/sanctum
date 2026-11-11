import type { Readable } from "node:stream";

import Docker from "dockerode";

import type { SpaceDockerLike } from "./host/space.js";

// Ported from v1's docker-runtime: the narrow slice of the Docker API the
// manager uses, shaped like dockerode so tests can pass a fake.

export const managedLabel = "sanctum.managed";
export const roleLabel = "sanctum.role";
// OCI titles are display metadata and may be replaced by the release builder.
export const imageServiceLabel = "sanctum.service";
export const imageVersionLabel = "org.opencontainers.image.version";

export type Labels = Record<string, string>;

export type ContainerInfo = {
  Id: string;
  Name: string;
  Image: string;
  RestartCount?: number;
  State: {
    Running: boolean;
    Restarting?: boolean;
    Status?: string;
    StartedAt?: string;
    FinishedAt?: string;
    ExitCode?: number;
    OOMKilled?: boolean;
    Error?: string;
  };
  Config: {
    Image: string;
    Env?: string[] | null;
    Labels?: Labels | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | string | null;
    [key: string]: unknown;
  };
  HostConfig: { NetworkMode?: string; [key: string]: unknown };
  NetworkSettings?: {
    Networks?: Record<
      string,
      { EndpointID?: string; IPAddress?: string; Aliases?: string[] | null }
    >;
  };
  Mounts?: Array<{ Type?: string; Name?: string; Destination: string }>;
};

export type ImageInfo = {
  Id: string;
  RepoTags?: string[] | null;
  Config?: {
    Env?: string[] | null;
    Labels?: Labels | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | string | null;
    [key: string]: unknown;
  };
};

export type ContainerCreateOptions = {
  name: string;
  Image: string;
  Env?: string[];
  Labels?: Labels;
  Cmd?: string[] | null;
  ExposedPorts?: Record<string, object>;
  Healthcheck?: Record<string, unknown>;
  HostConfig?: Record<string, unknown>;
  NetworkingConfig?: {
    EndpointsConfig: Record<string, { Aliases?: string[] }>;
  };
  [key: string]: unknown;
};

export type DockerContainerLike = {
  inspect: () => Promise<ContainerInfo>;
  start: () => Promise<unknown>;
  stop: (options?: { t?: number }) => Promise<unknown>;
  remove: (options?: { force?: boolean; v?: boolean }) => Promise<unknown>;
  rename: (options: { name: string }) => Promise<unknown>;
  update: (options: Record<string, unknown>) => Promise<unknown>;
  // A folder in the container as a tar, volumes included, running or not.
  getArchive: (options: { path: string }) => Promise<Readable>;
  putArchive: (
    file: NodeJS.ReadableStream,
    options: { path: string },
  ) => Promise<unknown>;
};

// A container the manager waits on: a helper it starts and watches end.
export type WaitableContainerLike = DockerContainerLike & {
  wait: (options?: {
    condition?: "not-running" | "next-exit" | "removed";
  }) => Promise<{ StatusCode: number }>;
};

export type DockerClientLike = {
  ping: () => Promise<unknown>;
  createContainer: (options: ContainerCreateOptions) => Promise<{ id: string }>;
  getContainer: (id: string) => DockerContainerLike;
  getImage: (name: string) => {
    inspect: () => Promise<ImageInfo>;
    remove: (options?: { force?: boolean }) => Promise<unknown>;
  };
  listImages: (options?: {
    filters?: Record<string, string[]>;
  }) => Promise<Array<{ Id: string; RepoTags?: string[] | null }>>;
  listContainers: (options?: {
    all?: boolean;
    filters?: Record<string, string[]>;
  }) => Promise<Array<{ Id: string; ImageID: string }>>;
  pull: (imageName: string) => Promise<unknown>;
  modem: {
    followProgress: (
      stream: unknown,
      callback: (error: Error | null) => void,
    ) => void;
  };
  createNetwork: (options: {
    Name: string;
    CheckDuplicate?: boolean;
    Labels?: Labels;
  }) => Promise<unknown>;
  getNetwork: (id: string) => {
    connect: (options: { Container: string }) => Promise<unknown>;
    disconnect: (options: {
      Container: string;
      Force?: boolean;
    }) => Promise<unknown>;
    inspect: () => Promise<{ Labels?: Labels | null }>;
  };
  createVolume: (options: {
    Name: string;
    Labels?: Labels;
    Driver?: string;
    DriverOpts?: Record<string, string>;
  }) => Promise<unknown>;
  getVolume: (id: string) => {
    inspect: () => Promise<{
      Labels?: Labels | null;
      Options?: Record<string, string> | null;
    }>;
    remove: () => Promise<unknown>;
  };
};

// What Settings → Status asks of Docker (host/status.ts): the host's system,
// the space images and volumes take, and each container's processes, whose
// memory Docker's stats can't give on a Raspberry Pi whose memory cgroup is off,
// as it is unless its boot settings turn it on.
type ProcessorReading = {
  cpu_usage?: { total_usage?: number };
  system_cpu_usage?: number;
  online_cpus?: number;
};

export type ContainerStats = {
  cpu_stats?: ProcessorReading;
  precpu_stats?: ProcessorReading;
  // Empty where the kernel keeps no count, as with the memory cgroup off.
  memory_stats?: {
    usage?: number;
    stats?: { inactive_file?: number; total_inactive_file?: number };
  };
};

type StatusContainerLike = {
  top: (options?: {
    ps_args?: string;
  }) => Promise<{ Titles: string[]; Processes: string[][] }>;
  // Without "one-shot", Docker takes a second to have two readings to compare.
  stats: (options: {
    stream: false;
    "one-shot"?: boolean;
  }) => Promise<ContainerStats>;
};

export type StatusDockerLike = {
  info: () => Promise<{
    OperatingSystem?: string;
    Architecture?: string;
    Name?: string;
    // Whether the kernel gives containers these. Raspberry Pi OS leaves memory
    // limits off until its boot settings turn them on.
    MemoryLimit?: boolean;
    SwapLimit?: boolean;
  }>;
  df: () => Promise<{
    LayersSize?: number;
    Volumes?: Array<{
      Name: string;
      UsageData?: { Size: number } | null;
    }> | null;
  }>;
  listContainers: (options?: {
    all?: boolean;
  }) => Promise<
    Array<{ Id: string; Names?: string[]; Labels?: Labels | null }>
  >;
  getContainer: (id: string) => StatusContainerLike;
};

// The resident memory of a container's processes, from `ps` on the host.
export function residentBytes(top: {
  Titles: string[];
  Processes: string[][];
}) {
  const column = top.Titles.findIndex((title) => title.toUpperCase() === "RSS");
  if (column < 0) return 0;
  return top.Processes.reduce(
    (sum, process) => sum + (Number(process[column]) || 0) * 1024,
    0,
  );
}

export type UsageDockerLike = {
  getContainer: (id: string) => StatusContainerLike;
};

// What the kernel charges a container, which is what a memory limit is held to,
// reckoned as `docker stats` does, without the file cache it would give back first.
// Null where it keeps no count, as with the memory cgroup off.
export function chargedBytes({ memory_stats: memory }: ContainerStats) {
  if (!memory?.usage) return null;
  const totalCache = memory.stats?.total_inactive_file;
  const cache =
    totalCache !== undefined && totalCache < memory.usage
      ? totalCache
      : (memory.stats?.inactive_file ?? 0);
  return cache < memory.usage ? memory.usage - cache : memory.usage;
}

// What a running container holds. What its processes hold says more than twice what
// it's charged for one at rest, since each counts the Node binary they all share, so
// that's only for a host whose kernel keeps no count. Null for one not running.
export async function memoryOf(container: StatusContainerLike) {
  const stats = await container
    .stats({ stream: false, "one-shot": true })
    .catch(() => null);
  const charged = stats && chargedBytes(stats);
  if (charged) return charged;
  const top = await container.top({ ps_args: "-o pid,rss" }).catch(() => null);
  return top ? residentBytes(top) : null;
}

export function createDockerClient(
  socketPath = "/var/run/docker.sock",
): DockerClientLike & StatusDockerLike & SpaceDockerLike & UsageDockerLike {
  return new Docker({ socketPath }) as unknown as DockerClientLike &
    StatusDockerLike &
    SpaceDockerLike &
    UsageDockerLike;
}

export async function inspectContainer(
  docker: Pick<DockerClientLike, "getContainer">,
  name: string,
): Promise<ContainerInfo | null> {
  try {
    return await docker.getContainer(name).inspect();
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

export async function inspectImage(
  docker: Pick<DockerClientLike, "getImage">,
  name: string,
): Promise<ImageInfo | null> {
  try {
    return await docker.getImage(name).inspect();
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

export async function pullImage(docker: DockerClientLike, imageName: string) {
  const stream = await docker.pull(imageName);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

// Pulls an image only when it is not on the host yet.
export async function ensureImage(docker: DockerClientLike, imageName: string) {
  if (await inspectImage(docker, imageName)) {
    return;
  }
  await pullImage(docker, imageName);
}

// "ghcr.io/koenkk/zigbee2mqtt:2.14.2" → "2.14.2".
export function tagOf(reference: string) {
  return /:([^:/@]+)$/.exec(reference)?.[1] ?? null;
}

export function isNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404
  );
}

export function isStaleDockerSandboxError(error: unknown) {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return false;
  }
  const message = String(error.message).toLowerCase();
  return message.includes("network sandbox") && message.includes("not found");
}

export function containerName(container: ContainerInfo) {
  return container.Name.replace(/^\//, "");
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
