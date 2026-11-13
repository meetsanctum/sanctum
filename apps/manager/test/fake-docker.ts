import { existsSync } from "node:fs";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";

import type {
  ContainerCreateOptions,
  ContainerInfo,
  DockerClientLike,
  Labels,
} from "../src/docker.js";

// An in-memory Docker, grown from v1's FakeDockerClient: containers by id and
// name, images that tags move between on pull, networks and volumes, and a
// health endpoint per image so update tests can stage broken releases.

export type ImageBehaviour = "healthy" | "unhealthy" | "crash";

type FakeImage = {
  id: string;
  tags: Set<string>;
  labels: Labels;
  env: string[];
  cmd: string[];
  behaviour: ImageBehaviour;
};

type FakeContainer = {
  id: string;
  name: string;
  ref: string;
  imageId: string;
  options: ContainerCreateOptions;
  running: boolean;
  startedAt?: Date;
  restartCount: number;
  networks: Record<string, { EndpointID?: string }>;
  // Docker keeps a container locked while its archive is being read.
  archiveBeingRead?: Readable;
  // How it last stopped.
  exitCode?: number;
  oomKilled?: boolean;
  finishedAt?: Date;
};

function bindsOf(container: FakeContainer) {
  const binds = (container.options.HostConfig?.Binds ?? []) as string[];
  return binds.map((bind) => {
    const [volume, target] = bind.split(":") as [string, string];
    return { volume, target };
  });
}

// What an image ships, as an archive of real files, for a volume that has a
// folder (FakeDocker.volumeFolders): each path's contents, or how it differs.
export type ArchivedFile =
  string | { content: string; mode: number } | { link: string };

export function archiveOf(files: Record<string, ArchivedFile>) {
  return JSON.stringify(files);
}

async function unpackInto(folder: string, archive: string) {
  const files = JSON.parse(archive) as Record<string, ArchivedFile>;
  for (const [path, file] of Object.entries(files)) {
    const target = join(folder, path);
    await mkdir(dirname(target), { recursive: true });
    if (typeof file === "string") {
      await writeFile(target, file);
    } else if ("link" in file) {
      await symlink(file.link, target);
    } else {
      await writeFile(target, file.content);
      await chmod(target, file.mode);
    }
  }
}

export function notFound(message = "Not found") {
  return Object.assign(new Error(message), { statusCode: 404 });
}

let sequence = 0;
const nextId = () => (++sequence).toString(16).padStart(64, "0");

export class FakeDocker implements DockerClientLike {
  containers = new Map<string, FakeContainer>();
  images = new Map<string, FakeImage>();
  // Images a pull can fetch, by reference.
  registry = new Map<string, Omit<FakeImage, "tags">>();
  networks = new Map<string, Labels>();
  internalNetworks = new Set<string>();
  volumes = new Map<string, Labels>();
  // How a local volume mounts what it's tied to.
  volumeOptions = new Map<string, Record<string, string>>();
  // What each volume holds, which is also its archive.
  volumeData = new Map<string, string>();
  // A volume whose archives unpack into a real folder, as Docker does, for
  // what the manager reads through its own mount of it.
  volumeFolders = new Map<string, string>();
  // What an image ships, by its id and then the path it's read from.
  imageArchives = new Map<string, Map<string, string>>();
  events: string[] = [];
  pingError: Error | null = null;
  startError: Error | null = null;
  // Breaks reading a volume, partway through, until cleared.
  getArchiveError: Error | null = null;
  // Breaks the next write to a volume.
  putArchiveError: Error | null = null;
  // Containers removed without the anonymous volumes their images declare.
  removedKeepingVolumes: string[] = [];
  // What the kernel gives containers: Raspberry Pi OS has no memory limits until
  // its boot settings turn them on, and Docker then discards any asked for.
  memoryLimit = true;
  // Changes what a container got, as a daemon's defaults might.
  onCreate: ((options: ContainerCreateOptions) => void) | null = null;
  // Called when a container starts, e.g. to have a new core migrate its data.
  onStart: ((name: string, version: string | undefined) => void) | null = null;

  modem = {
    followProgress: (
      _stream: unknown,
      callback: (error: Error | null) => void,
    ) => callback(null),
  };

  // Publishes an image that a later pull of `ref` fetches.
  publish(
    ref: string,
    options: {
      title: string;
      version: string;
      behaviour?: ImageBehaviour;
    },
  ) {
    const image = {
      id: `sha256:${nextId()}`,
      labels: {
        "org.opencontainers.image.title": options.title,
        "sanctum.service": options.title.replace(/^sanctum-/, ""),
        "org.opencontainers.image.version": options.version,
      },
      env: [`SANCTUM_VERSION=${options.version}`, "NODE_ENV=production"],
      cmd: ["node", "dist/index.js"],
      behaviour: options.behaviour ?? "healthy",
    };
    this.registry.set(ref, image);
    return image.id;
  }

  // Makes `ref` fetch the same image as `existing`, like a rebuild that
  // changed nothing.
  alias(ref: string, existing: string) {
    const image = this.registry.get(existing);
    if (!image) {
      throw notFound(existing);
    }
    this.registry.set(ref, image);
  }

  // Publishes and pulls an image, as if it were already on the host.
  load(ref: string, options: Parameters<FakeDocker["publish"]>[1]) {
    const id = this.publish(ref, options);
    this.tag(ref, id);
    return id;
  }

  // Creates and starts a container directly, as Compose or a person would.
  run(options: ContainerCreateOptions) {
    const id = this.create(options);
    const container = this.containers.get(id) as FakeContainer;
    container.running = true;
    container.startedAt = new Date();
    return container;
  }

  container(name: string) {
    return [...this.containers.values()].find((c) => c.name === name);
  }

  imageOf(name: string) {
    const container = this.container(name);
    return container ? this.images.get(container.imageId) : undefined;
  }

  private tag(ref: string, id: string) {
    const published = this.registry.get(ref);
    if (!published) {
      throw notFound(`manifest for ${ref} not found`);
    }
    for (const image of this.images.values()) {
      image.tags.delete(ref);
    }
    const existing = this.images.get(id);
    if (existing) {
      existing.tags.add(ref);
    } else {
      this.images.set(id, { ...published, tags: new Set([ref]) });
    }
  }

  private resolveImage(ref: string) {
    return (
      this.images.get(ref) ??
      [...this.images.values()].find((image) => image.tags.has(ref))
    );
  }

  private find(idOrName: string) {
    return (
      this.containers.get(idOrName) ??
      [...this.containers.values()].find(
        (container) => container.name === idOrName,
      )
    );
  }

  private create(asked: ContainerCreateOptions) {
    // Docker keeps its own record of what was asked.
    const options = structuredClone(asked);
    if (this.container(options.name)) {
      throw Object.assign(new Error(`Conflict: ${options.name}`), {
        statusCode: 409,
      });
    }
    const image = this.resolveImage(options.Image);
    if (!image) {
      throw notFound(`No such image: ${options.Image}`);
    }
    const id = nextId();
    this.onCreate?.(options);
    this.containers.set(id, {
      id,
      name: options.name,
      ref: options.Image,
      imageId: image.id,
      options,
      running: false,
      restartCount: 0,
      networks: {},
    });
    this.events.push(
      `create ${options.name} ${image.labels["org.opencontainers.image.version"]}`,
    );
    return id;
  }

  async info() {
    return { MemoryLimit: this.memoryLimit, SwapLimit: this.memoryLimit };
  }

  async ping() {
    if (this.pingError) {
      throw this.pingError;
    }
    return "OK";
  }

  async createContainer(options: ContainerCreateOptions) {
    return { id: this.create(options) };
  }

  getContainer(idOrName: string) {
    const get = () => {
      const container = this.find(idOrName);
      if (!container) {
        throw notFound(`No such container: ${idOrName}`);
      }
      return container;
    };
    return {
      inspect: async (): Promise<ContainerInfo> => {
        const container = get();
        const image = this.images.get(container.imageId) as FakeImage;
        const networkMode =
          (container.options.HostConfig?.NetworkMode as string | undefined) ??
          "bridge";
        return {
          Id: container.id,
          Name: `/${container.name}`,
          Image: container.imageId,
          RestartCount: container.restartCount,
          State: {
            Running: container.running,
            Restarting: false,
            Status: container.running
              ? "running"
              : container.startedAt
                ? "exited"
                : "created",
            StartedAt:
              container.startedAt?.toISOString() ?? "0001-01-01T00:00:00Z",
            FinishedAt:
              container.finishedAt?.toISOString() ?? "0001-01-01T00:00:00Z",
            ExitCode: container.exitCode ?? 0,
            OOMKilled: container.oomKilled ?? false,
          },
          Config: {
            Image: container.ref,
            WorkingDir: container.options.WorkingDir ?? "",
            ...(container.options.User
              ? { User: container.options.User as string }
              : {}),
            Hostname: container.id.slice(0, 12),
            Env: [...image.env, ...(container.options.Env ?? [])],
            Labels: { ...image.labels, ...container.options.Labels },
            Cmd: container.options.Cmd ?? image.cmd,
            Entrypoint: ["docker-entrypoint.sh"],
          },
          HostConfig: {
            NetworkMode: networkMode,
            ...container.options.HostConfig,
            ...(this.memoryLimit ? {} : { Memory: 0, MemorySwap: 0 }),
            // Docker fills in what it wasn't told.
            ...(container.options.HostConfig?.RestartPolicy
              ? {
                  RestartPolicy: {
                    MaximumRetryCount: 0,
                    ...(container.options.HostConfig.RestartPolicy as object),
                  },
                }
              : {}),
          },
          NetworkSettings: { Networks: container.networks },
          Mounts: [],
        };
      },
      start: async () => {
        const container = get();
        if (this.startError) {
          const error = this.startError;
          this.startError = null;
          throw error;
        }
        const image = this.images.get(container.imageId) as FakeImage;
        container.running = image.behaviour !== "crash";
        container.startedAt = new Date();
        for (const network of Object.keys(
          container.options.NetworkingConfig?.EndpointsConfig ?? {},
        )) {
          container.networks[network] = { EndpointID: "endpoint" };
        }
        this.events.push(`start ${container.name}`);
        this.onStart?.(
          container.name,
          image.labels["org.opencontainers.image.version"],
        );
      },
      stop: async () => {
        const container = get();
        if (container.running) {
          container.exitCode = 143;
          container.finishedAt = new Date();
        }
        container.running = false;
        this.events.push(`stop ${container.name}`);
      },
      restart: async () => {
        const container = get();
        container.running = true;
        container.startedAt = new Date();
        this.events.push(`restart ${container.name}`);
      },
      remove: async (options?: { v?: boolean }) => {
        const container = get();
        const archive = container.archiveBeingRead;
        if (archive && !archive.destroyed && !archive.readableEnded) {
          throw new Error(
            `${container.name} is locked: this would wait forever on Docker`,
          );
        }
        this.containers.delete(container.id);
        if (!options?.v) this.removedKeepingVolumes.push(container.name);
        this.events.push(`remove ${container.name}`);
      },
      rename: async ({ name }: { name: string }) => {
        const container = get();
        if (this.container(name)) {
          throw Object.assign(new Error(`Conflict: ${name}`), {
            statusCode: 409,
          });
        }
        this.events.push(`rename ${container.name} ${name}`);
        container.name = name;
      },
      update: async (options: Record<string, unknown>) => {
        const container = get();
        container.options.HostConfig = {
          ...container.options.HostConfig,
          ...options,
        };
      },
      getArchive: async ({ path }: { path: string }) => {
        const container = get();
        const bind = bindsOf(container).find(
          ({ target }) => `${target}/.` === path,
        );
        const shipped = this.imageArchives.get(container.imageId)?.get(path);
        if (!bind && shipped === undefined) {
          throw notFound(`Nothing at ${path}`);
        }
        this.events.push(`read ${bind?.volume ?? path}`);
        const failure = this.getArchiveError;
        const archive = failure
          ? new Readable({
              read() {
                this.destroy(failure);
              },
            })
          : Readable.from([
              shipped ?? this.volumeData.get(bind?.volume ?? "") ?? "",
            ]);
        container.archiveBeingRead = archive;
        archive.once("close", () => {
          container.archiveBeingRead = undefined;
        });
        return archive;
      },
      putArchive: async (
        file: NodeJS.ReadableStream,
        { path }: { path: string },
      ) => {
        const container = get();
        const bind = bindsOf(container).find(
          ({ target }) => target === path || path.startsWith(`${target}/`),
        );
        if (!bind) {
          throw notFound(`No volume at ${path}`);
        }
        if (container.archiveBeingRead) {
          throw new Error(
            `${container.name} is locked: this would wait forever on Docker`,
          );
        }
        if (this.putArchiveError) {
          const error = this.putArchiveError;
          this.putArchiveError = null;
          throw error;
        }
        const folder = this.volumeFolders.get(bind.volume);
        if (folder) {
          await unpackInto(
            join(folder, path.slice(bind.target.length)),
            await text(file),
          );
        } else {
          this.volumeData.set(bind.volume, await text(file));
        }
        this.events.push(`write ${bind.volume}`);
      },
    };
  }

  getImage(ref: string) {
    return {
      inspect: async () => {
        const image = this.resolveImage(ref);
        if (!image) {
          throw notFound(`No such image: ${ref}`);
        }
        return {
          Id: image.id,
          RepoTags: [...image.tags],
          Config: {
            Env: image.env,
            Labels: image.labels,
            Cmd: image.cmd,
            Entrypoint: ["docker-entrypoint.sh"],
          },
        };
      },
      remove: async () => {
        const image = this.resolveImage(ref);
        if (image) {
          this.images.delete(image.id);
        }
      },
    };
  }

  async listImages(options?: { filters?: Record<string, string[]> }) {
    const wanted = options?.filters?.label ?? [];
    return [...this.images.values()]
      .filter((image) =>
        wanted.every((filter) => {
          const [key, value] = filter.split("=");
          return image.labels[key as string] === value;
        }),
      )
      .map((image) => ({ Id: image.id, RepoTags: [...image.tags] }));
  }

  async listContainers() {
    return [...this.containers.values()].map((container) => ({
      Id: container.id,
      ImageID: container.imageId,
    }));
  }

  async pull(ref: string) {
    const published = this.registry.get(ref);
    if (!published) {
      throw notFound(`manifest for ${ref} not found`);
    }
    this.tag(ref, published.id);
    this.events.push(`pull ${ref}`);
    return {};
  }

  async createNetwork(options: {
    Name: string;
    Labels?: Labels;
    Internal?: boolean;
  }) {
    this.networks.set(options.Name, options.Labels ?? {});
    if (options.Internal) this.internalNetworks.add(options.Name);
  }

  async listNetworks(options: { filters?: { label?: string[] } } = {}) {
    const has = (labels: Labels, filter: string) => {
      const [key, value] = filter.split("=");
      return value === undefined ? key! in labels : labels[key!] === value;
    };
    return [...this.networks]
      .filter(([, labels]) =>
        (options.filters?.label ?? []).every((each) => has(labels, each)),
      )
      .map(([Name, Labels]) => ({ Name, Labels }));
  }

  getNetwork(name: string) {
    return {
      remove: async () => {
        if (!this.networks.has(name)) throw notFound();
        if (
          [...this.containers.values()].some(
            (container) => container.networks[name],
          )
        ) {
          throw new Error(`Network ${name} is still in use`);
        }
        this.networks.delete(name);
        this.internalNetworks.delete(name);
        this.events.push(`remove network ${name}`);
      },
      connect: async ({ Container }: { Container: string }) => {
        const container = this.find(Container);
        if (container) {
          container.networks[name] = { EndpointID: "endpoint" };
        }
        this.events.push(`connect ${Container} ${name}`);
      },
      disconnect: async ({ Container }: { Container: string }) => {
        const container = this.find(Container);
        if (container) delete container.networks[name];
        this.events.push(`disconnect ${Container} ${name}`);
      },
      inspect: async () => {
        const labels = this.networks.get(name);
        if (!labels) {
          throw notFound();
        }
        return { Labels: labels, Internal: this.internalNetworks.has(name) };
      },
    };
  }

  async createVolume(options: {
    Name: string;
    Labels?: Labels;
    DriverOpts?: Record<string, string>;
  }) {
    this.volumes.set(options.Name, options.Labels ?? {});
    if (options.DriverOpts) {
      this.volumeOptions.set(options.Name, options.DriverOpts);
    }
  }

  getVolume(name: string) {
    return {
      inspect: async () => {
        const labels = this.volumes.get(name);
        if (!labels) {
          throw notFound();
        }
        return { Labels: labels, Options: this.volumeOptions.get(name) };
      },
      remove: async () => {
        if (!this.volumes.has(name)) {
          throw notFound();
        }
        const used = [...this.containers.values()].some((container) =>
          bindsOf(container).some(({ volume }) => volume === name),
        );
        if (used) {
          throw Object.assign(new Error(`Volume ${name} is in use`), {
            statusCode: 409,
          });
        }
        this.volumes.delete(name);
        this.volumeData.delete(name);
        this.events.push(`remove volume ${name}`);
      },
    };
  }

  // Answers health checks the way the running core and manager would.
  fetch: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const core = new URL(url).port === "4100";
    const container = this.container(core ? "sanctum-core" : "sanctum-manager");
    if (!container?.running) {
      throw new TypeError("fetch failed");
    }
    const image = this.images.get(container.imageId) as FakeImage;
    if (image.behaviour === "unhealthy") {
      return Response.json({ status: "error" }, { status: 500 });
    }
    return Response.json({
      status: "ok",
      version: image.labels["org.opencontainers.image.version"],
      ...(core && this.coreDataDir
        ? {
            updatePending: existsSync(join(this.coreDataDir, "update-pending")),
          }
        : {}),
    });
  };

  coreDataDir: string | null = null;
}
