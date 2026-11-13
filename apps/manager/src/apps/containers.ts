import { access, chown, mkdir } from "node:fs/promises";
import { totalmem } from "node:os";
import { join } from "node:path";

import {
  coreContainerName,
  hasOnlyAppFolders,
  managerDataVolumeName,
} from "../core-container.js";
import { assertManaged, managedLabels, type Log } from "../docker-resources.js";
import {
  ensureImage,
  inspectContainer,
  type ContainerCreateOptions,
  type ContainerInfo,
  type DockerClientLike,
  type StatusDockerLike,
} from "../docker.js";
import { isOurs, stacked } from "../stack.js";
import {
  brokerNetworkFor,
  brokerNetworkName,
  removeBrokerNetwork,
  usesBroker,
} from "./broker.js";
import { defaultImageMb, imageVolumeName, type AppImages } from "./images.js";
import { AppRefusal } from "./refusal.js";

// An app's own container, beside the core: the official Node image, the app's
// staged package read-only, its socket's folder, and no network but the
// broker's, for an app that uses it (broker.ts). The core
// decides when each starts, and Docker never restarts one by itself, so whoever
// supervises it hears why it stopped. What runs in it comes with the app's own
// copy of the SDK.

// One digest for the core, the manager and every app, so they share its layers
// on a host (apps/core/Dockerfile, apps/manager/Dockerfile).
export const nodeImage =
  "node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85";

export const appRole = "app";
export const appLabel = "sanctum.app";
const folderLabel = "sanctum.app.folder";
const memoryLabel = "sanctum.app.memory";

// Each folder holds an app's sockets, under the manager's data volume.
const socketsFolder = "sockets";
const packagesFolder = "packages";
const packageTarget = "/package";
const socketTarget = "/run/sanctum-app";
const runner = `${packageTarget}/node_modules/@meetsanctum/app-sdk/dist/runner.js`;
// An unprivileged user, the same for every app: each sees only its own folders.
const appUser = { uid: 1000, gid: 1000 };
const temporarySpace = "size=16m";
const processes = 64;
const halfACore = 500_000_000;
const mebibyte = 1024 * 1024;
// What the host keeps for itself, the core and its services.
const keptForTheHost = (total: number) =>
  Math.max(1024 * mebibyte, Math.floor(total / 4));

export const appIdPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
export const dataTarget = "/data";
export const packageFolderPattern = /^(?!.*\.\.)[0-9A-Za-z][0-9A-Za-z.+-]*$/;
export const smallestMemoryMb = 64;
export const largestMemoryMb = 4096;

export type AppContainerSpec = {
  app: string;
  // Its staged package's folder under /data/packages/<id>.
  folder: string;
  memoryMb: number;
  // The size of its data's image, the first time; 256 MB unless it asks.
  dataMb?: number;
};

export type AppContainerStatus = {
  app: string;
  state: "running" | "stopped" | "none";
  // A start that found this one running as it would make it, and left it.
  kept?: boolean;
  folder?: string;
  memoryMb?: number;
  // Why it stopped, as Docker saw it.
  exitCode?: number;
  outOfMemory?: boolean;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type AppDockerLike = DockerClientLike & Pick<StatusDockerLike, "info">;

export function appContainerName(app: string) {
  return stacked(`sanctum-app-${app}`);
}

function nextContainerName(app: string) {
  return `${appContainerName(app)}-next`;
}

// Node collects garbage before the kernel steps in. Its young space is small,
// since most of an app's memory at rest would otherwise be that.
function nodeFlags(memoryMb: number) {
  return [
    `--max-old-space-size=${Math.floor(memoryMb * 0.75)}`,
    "--max-semi-space-size=2",
  ];
}

export function appContainerOptions(
  spec: AppContainerSpec,
  dataVolume: string,
  network?: string,
): ContainerCreateOptions {
  const memory = spec.memoryMb * mebibyte;
  return {
    name: appContainerName(spec.app),
    Image: nodeImage,
    User: `${appUser.uid}:${appUser.gid}`,
    WorkingDir: packageTarget,
    Env: [
      "NODE_ENV=production",
      `SANCTUM_APP=${spec.app}`,
      `SANCTUM_APP_SOCKETS=${socketTarget}`,
    ],
    Cmd: ["node", ...nodeFlags(spec.memoryMb), runner],
    Labels: {
      ...managedLabels(appRole),
      [appLabel]: spec.app,
      [folderLabel]: spec.folder,
      [memoryLabel]: String(spec.memoryMb),
    },
    HostConfig: {
      NetworkMode: network ?? "none",
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": temporarySpace },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      // With no swap on top, which Docker otherwise allows as much again of.
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: halfACore,
      PidsLimit: processes,
      Mounts: [
        {
          Type: "volume",
          Source: managerDataVolumeName,
          Target: packageTarget,
          ReadOnly: true,
          VolumeOptions: {
            NoCopy: true,
            Subpath: `${packagesFolder}/${spec.app}/${spec.folder}`,
          },
        },
        {
          Type: "volume",
          Source: managerDataVolumeName,
          Target: socketTarget,
          // Connecting needs no writing, and the core binds and changes the
          // socket here as root, so nothing of the app's may touch the folder.
          ReadOnly: true,
          VolumeOptions: {
            NoCopy: true,
            Subpath: `${socketsFolder}/${spec.app}`,
          },
        },
        {
          Type: "volume",
          Source: dataVolume,
          Target: dataTarget,
          VolumeOptions: { NoCopy: true },
        },
      ],
      RestartPolicy: { Name: "no" },
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "10m", "max-file": "3" },
      },
    },
  };
}

type Mount = {
  Target?: string;
  Source?: string;
  ReadOnly?: boolean;
  VolumeOptions?: { Subpath?: string };
};

// What Docker made differs from what was asked: a daemon's defaults or a kernel
// can quietly drop a setting. Memory limits may only be missing where the kernel
// has none to give, which is said in Needs attention.
export function effectiveDifferences(
  desired: ContainerCreateOptions,
  actual: ContainerInfo,
  memoryLimits: boolean,
) {
  const wanted = desired.HostConfig!;
  const got = actual.HostConfig;
  const differences: string[] = [];
  const same = (name: string, have: unknown, want: unknown) => {
    if (JSON.stringify(have) !== JSON.stringify(want)) differences.push(name);
  };
  same("its user", actual.Config.User, desired.User);
  same("its network", got.NetworkMode, wanted.NetworkMode);
  same("its read-only root", got.ReadonlyRootfs, wanted.ReadonlyRootfs);
  same("its temporary space", got.Tmpfs, wanted.Tmpfs);
  same("its capabilities", got.CapDrop, wanted.CapDrop);
  same("its privileges", got.Privileged ?? false, false);
  same("its security options", got.SecurityOpt, wanted.SecurityOpt);
  same("its processor", got.NanoCpus, wanted.NanoCpus);
  same("its processes", got.PidsLimit, wanted.PidsLimit);
  same(
    "its restarts",
    (got.RestartPolicy as { Name?: string } | undefined)?.Name,
    "no",
  );
  if (memoryLimits) {
    same("its memory", got.Memory, wanted.Memory);
    same("its swap", got.MemorySwap, wanted.MemorySwap);
  }
  const mount = ({ Target, Source, ReadOnly, VolumeOptions }: Mount) => ({
    Target,
    Source,
    ReadOnly: ReadOnly ?? false,
    Subpath: VolumeOptions?.Subpath,
  });
  same(
    "its folders",
    ((got.Mounts ?? []) as Mount[]).map(mount),
    (wanted.Mounts as Mount[]).map(mount),
  );
  return differences;
}

// Whether a running container is the one a start would make: the same package
// and memory, as this manager makes containers now, which a manager's update
// may have changed.
export function isAsMade(
  desired: ContainerCreateOptions,
  actual: ContainerInfo,
  memoryLimits: boolean,
  imageEnv: string[],
) {
  const labels = actual.Config.Labels ?? {};
  const wantedLabels = desired.Labels ?? {};
  // Docker merges image defaults with the manager's variables by name.
  const environment = (entries: string[]) =>
    [
      ...new Map(entries.map((entry) => [entry.split("=")[0], entry])).values(),
    ].sort();
  return (
    actual.State.Running &&
    actual.Config.Image === desired.Image &&
    JSON.stringify(actual.Config.Cmd) === JSON.stringify(desired.Cmd) &&
    actual.Config.WorkingDir === desired.WorkingDir &&
    JSON.stringify(environment(actual.Config.Env ?? [])) ===
      JSON.stringify(environment([...imageEnv, ...(desired.Env ?? [])])) &&
    Object.entries(wantedLabels).every(
      ([key, value]) => labels[key] === value,
    ) &&
    effectiveDifferences(desired, actual, memoryLimits).length === 0
  );
}

// The folders the core's container and apps' mount by subpath. Docker refuses a
// mount whose subpath doesn't exist, and Compose can't add a volume on an update.
export async function ensureAppFolders(dataDir: string) {
  await mkdir(join(dataDir, socketsFolder), { recursive: true });
  await mkdir(join(dataDir, packagesFolder), { recursive: true });
}

export function createAppContainers(options: {
  docker: AppDockerLike;
  // The manager's data volume, mounted here.
  dataDir: string;
  log: Log;
  totalMemory?: () => number;
  // Gives an app's socket folder to its user; only root can.
  ownFolder?: (path: string) => Promise<void>;
  images: Pick<AppImages, "ensure">;
  // Clears maintenance left behind by a previous manager, inside the queue.
  prepareImage?: (app: string) => Promise<void>;
}) {
  const { docker, dataDir, log, images, prepareImage } = options;
  const totalMemory = options.totalMemory ?? totalmem;
  const ownFolder =
    options.ownFolder ??
    ((path: string) => chown(path, appUser.uid, appUser.gid));
  let knownLimits: boolean | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  // One at a time, so two starts can't both fit in the space for one.
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  }

  async function memoryLimits() {
    if (knownLimits === undefined) {
      const info = await docker.info();
      knownLimits = info.MemoryLimit !== false && info.SwapLimit !== false;
    }
    return knownLimits;
  }

  async function inspectApp(app: string) {
    const name = appContainerName(app);
    const existing = await inspectContainer(docker, name);
    if (existing) {
      assertManaged({ labels: existing.Config.Labels, name }, appRole);
    }
    return existing;
  }

  function statusOf(app: string, container: ContainerInfo | null) {
    if (!container) return { app, state: "none" } as AppContainerStatus;
    const labels = container.Config.Labels ?? {};
    const { State: state } = container;
    const started = state.StartedAt && !state.StartedAt.startsWith("0001");
    const finished = state.FinishedAt && !state.FinishedAt.startsWith("0001");
    const status: AppContainerStatus = {
      app,
      state: state.Running ? "running" : "stopped",
      folder: labels[folderLabel],
      memoryMb: Number(labels[memoryLabel]),
      ...(started ? { startedAt: state.StartedAt } : {}),
    };
    if (!state.Running && finished) {
      status.exitCode = state.ExitCode ?? 0;
      status.outOfMemory = state.OOMKilled ?? false;
      status.finishedAt = state.FinishedAt;
      if (state.Error) status.error = state.Error;
    }
    return status;
  }

  async function all() {
    const listed = await docker.listContainers({
      all: true,
      filters: { label: [`sanctum.role=${appRole}`] },
    });
    const containers: ContainerInfo[] = [];
    for (const { Id } of listed) {
      const container = await inspectContainer(docker, Id);
      const labels = container?.Config.Labels;
      if (
        container &&
        labels?.[appLabel] &&
        isOurs(labels) &&
        container.Name.replace(/^\//, "") === appContainerName(labels[appLabel])
      ) {
        containers.push(container);
      }
    }
    return containers;
  }

  async function assertFits(spec: AppContainerSpec) {
    const others = (await all()).filter(
      (each) =>
        each.State.Running && each.Config.Labels?.[appLabel] !== spec.app,
    );
    const taken = others.reduce(
      (sum, each) => sum + Number(each.Config.Labels?.[memoryLabel] ?? 0),
      0,
    );
    const total = totalMemory();
    const room = (total - keptForTheHost(total)) / mebibyte;
    if (taken + spec.memoryMb > room) {
      throw new AppRefusal(
        `${spec.app} needs ${spec.memoryMb} MB, and only ${Math.max(0, Math.floor(room - taken))} MB are left beside the others`,
        409,
      );
    }
  }

  async function remove(app: string) {
    const existing = await inspectApp(app);
    if (!existing) return;
    const container = docker.getContainer(existing.Id);
    if (existing.State.Running) {
      await container.stop({ t: 10 }).catch(() => undefined);
    }
    await container.remove({ force: true, v: true });
  }

  // One a crash left behind on its way to replacing the app's.
  async function removeNext(app: string) {
    const name = nextContainerName(app);
    const left = await inspectContainer(docker, name);
    if (left) {
      assertManaged({ labels: left.Config.Labels, name }, appRole);
      await docker.getContainer(left.Id).remove({ force: true, v: true });
    }
  }

  // The app's running container, when it's the one a start would make now.
  async function keptAsMade(spec: AppContainerSpec, packageDir: string) {
    const existing = await inspectApp(spec.app);
    if (!existing?.State.Running) return undefined;
    const network = (await usesBroker(packageDir))
      ? brokerNetworkName(spec.app)
      : undefined;
    const desired = appContainerOptions(
      spec,
      imageVolumeName(spec.app),
      network,
    );
    const image = await docker.getImage(existing.Image).inspect();
    if (
      !isAsMade(
        desired,
        existing,
        await memoryLimits(),
        image.Config?.Env ?? [],
      )
    )
      return undefined;
    log(`Keeping ${desired.name} on ${spec.folder}`);
    return { ...statusOf(spec.app, existing), kept: true };
  }

  async function releaseImage(app: string) {
    const existing = await inspectApp(app);
    if (existing?.State.Running) {
      throw new AppRefusal(`${app} is running`, 409);
    }
    await removeNext(app);
    if (existing) {
      await docker.getContainer(existing.Id).remove({ v: true });
    }
  }

  return {
    memoryLimits,

    // Whether it can run apps yet: an update replaces the core before the
    // manager, so the core may still lack what apps need (core-container.ts).
    async ready() {
      const core = await inspectContainer(docker, coreContainerName);
      return core !== null && hasOnlyAppFolders(core);
    },

    // Starts the app's container, replacing any it had: the core restarts each
    // through this. With `keep`, one already running as this would make it goes
    // on, as after the core restarted: its app is said to be found again.
    start(spec: AppContainerSpec, { keep = false }: { keep?: boolean } = {}) {
      return inTurn(async () => {
        const packageDir = join(dataDir, packagesFolder, spec.app, spec.folder);
        await access(join(packageDir, "package.json")).catch(() => {
          throw new AppRefusal(
            `${spec.app} has no staged package ${spec.folder}`,
            404,
          );
        });
        if (keep) {
          const kept = await keptAsMade(spec, packageDir);
          if (kept) return kept;
        }
        await assertFits(spec);
        await prepareImage?.(spec.app);
        const dataVolume = await images.ensure(
          spec.app,
          spec.dataMb ?? defaultImageMb,
          () => releaseImage(spec.app),
        );
        const sockets = join(dataDir, socketsFolder, spec.app);
        await mkdir(sockets, { recursive: true, mode: 0o700 });
        await ownFolder(sockets);
        await ensureImage(docker, nodeImage);
        await removeNext(spec.app);

        const network = (await usesBroker(packageDir))
          ? await brokerNetworkFor(docker, spec.app, log)
          : undefined;

        // The one it replaces keeps running until this one is sure to start.
        const desired = appContainerOptions(spec, dataVolume, network);
        const { id } = await docker.createContainer({
          ...desired,
          name: nextContainerName(spec.app),
        });
        const container = docker.getContainer(id);
        const differences = effectiveDifferences(
          desired,
          await container.inspect(),
          await memoryLimits(),
        );
        if (differences.length > 0) {
          await container.remove({ force: true, v: true });
          throw new AppRefusal(
            `Docker would not give ${spec.app} ${differences.join(", ")}`,
            500,
          );
        }
        await remove(spec.app);
        await container.rename({ name: desired.name });
        log(`Starting ${desired.name} from ${spec.folder}`);
        await container.start();
        return statusOf(spec.app, await container.inspect());
      });
    },

    // Work on its image, in turn with starting it. Unless it may go on running,
    // refused while it runs: Docker has the image mounted, and SQLite has it open.
    onItsImage<T>(
      app: string,
      work: (releaseVolume: () => Promise<void>) => Promise<T>,
      options: { whileRunning?: boolean } = {},
    ) {
      return inTurn(async () => {
        const existing = await inspectApp(app);
        if (existing?.State.Running && !options.whileRunning) {
          throw new AppRefusal(`${app} is running`, 409);
        }
        await prepareImage?.(app);
        return work(() => releaseImage(app));
      });
    },

    // Stops it and keeps the container, whose exit says why it stopped.
    stop(app: string) {
      return inTurn(async () => {
        const existing = await inspectApp(app);
        if (existing?.State.Running) {
          log(`Stopping ${appContainerName(app)}`);
          try {
            await docker.getContainer(existing.Id).stop({ t: 10 });
          } catch (error) {
            // It can exit between the inspection and Docker's stop request.
            if ((await inspectApp(app))?.State.Running !== false) throw error;
          }
        }
        return statusOf(app, await inspectApp(app));
      });
    },

    remove(app: string) {
      return inTurn(async () => {
        log(`Removing ${appContainerName(app)}`);
        await removeNext(app);
        await remove(app);
        await removeBrokerNetwork(docker, app, log);
      });
    },

    async status(app: string) {
      return statusOf(app, await inspectApp(app));
    },

    async list() {
      const containers = await all();
      return containers.map((each) =>
        statusOf(each.Config.Labels![appLabel]!, each),
      );
    },
  };
}

export type AppContainers = ReturnType<typeof createAppContainers>;
