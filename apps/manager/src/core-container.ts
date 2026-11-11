import {
  assertManaged,
  ensureNetwork,
  ensureVolume,
  managedLabels,
  startExistingContainer,
  type Log,
} from "./docker-resources.js";
import {
  ensureImage,
  inspectContainer,
  type ContainerCreateOptions,
  type ContainerInfo,
  type DockerClientLike,
} from "./docker.js";
import { restartPolicy, stack, stackCore, stacked } from "./stack.js";

// The core runs in a container the manager owns. Compose starts only the
// manager; the manager creates the core, keeps it running and updates it.

export const coreContainerName = stacked("sanctum-core");
// The core an update replaced, kept stopped until the update commits.
export const previousCoreContainerName = stacked("sanctum-core-previous");
export const coreRole = "core";
// Services such as the MQTT broker join this network to reach the core.
export const sanctumNetworkName = stacked("sanctum");
// Created by Compose, which mounts it into the manager for backups.
export const coreVolumeName = stacked("sanctum-core-data");
export const corePort = 4100;
// The manager's socket lives in this volume, which Compose creates and mounts
// into the manager; the core is the only other container that mounts it.
export const socketVolumeName = stacked("sanctum-manager-socket");
export const socketDirectory = "/run/sanctum";
// Compose names it (deploy/compose.yml), so an update can't change it. It holds
// apps' sockets and staged packages, which the core's container and apps' mount
// by subpath.
export const managerDataVolumeName = stacked("sanctum-manager-data");
export const coreAppSocketsTarget = "/run/sanctum-apps";
export const corePackagesTarget = "/packages";
// The group the socket belongs to. The core's container joins it.
export const socketGroupId = 4200;
// The origins the apps load the client from, which may read the core's
// responses: the desktop app's (apps/desktop).
export const clientOrigins = ["app://sanctum"];

export function coreContainerOptions(image: string): ContainerCreateOptions {
  return {
    name: coreContainerName,
    Image: image,
    Labels: {
      ...managedLabels(coreRole),
      // Keep the requested mounts: Docker Desktop rewrites their source
      // paths inside its VM, so its inspected Binds cannot be compared to
      // paths on the Mac when the stack starts again.
      ...(stackCore
        ? { "sanctum.stack.core-binds": stackCore.binds.join(";") }
        : {}),
    },
    Env: [
      `CORE_ALLOWED_ORIGINS=${clientOrigins.join(",")}`,
      ...(stackCore?.env ?? []),
    ],
    ExposedPorts: { [`${corePort}/tcp`]: {} },
    // Docker's own liveness check, inside the container: the core serves only
    // HTTPS, and the update path checks it against the host CA instead. A
    // stack's core may serve plain HTTP.
    Healthcheck: stack
      ? { Test: ["NONE"] }
      : {
          Test: [
            "CMD",
            "wget",
            "--no-check-certificate",
            "-qO-",
            `https://127.0.0.1:${corePort}/api/health`,
          ],
          Interval: 30_000_000_000,
          Timeout: 5_000_000_000,
          Retries: 3,
        },
    HostConfig: {
      Binds: [
        `${coreVolumeName}:/data`,
        `${socketVolumeName}:${socketDirectory}`,
        ...(stackCore?.binds ?? []),
      ],
      Mounts: [
        {
          Type: "volume",
          Source: managerDataVolumeName,
          Target: coreAppSocketsTarget,
          VolumeOptions: { NoCopy: true, Subpath: "sockets" },
        },
        {
          Type: "volume",
          Source: managerDataVolumeName,
          Target: corePackagesTarget,
          ReadOnly: true,
          VolumeOptions: { NoCopy: true, Subpath: "packages" },
        },
      ],
      GroupAdd: [String(socketGroupId)],
      PortBindings: {
        [`${corePort}/tcp`]: [
          stackCore?.port
            ? { HostIp: "127.0.0.1", HostPort: String(stackCore.port) }
            : { HostPort: String(corePort) },
        ],
      },
      RestartPolicy: restartPolicy,
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "10m", "max-file": "3" },
      },
    },
    NetworkingConfig: { EndpointsConfig: { [sanctumNetworkName]: {} } },
  };
}

export async function createCoreContainer(
  docker: DockerClientLike,
  image: string,
) {
  const created = await docker.createContainer(coreContainerOptions(image));
  return created.id;
}

// Whether a core's container can reach apps' sockets and packages. An older
// manager's update makes one that can't, and only a new manager can tell: an
// installed manager can't be taught, and it starts the new core first.
export function hasAppFolders(core: ContainerInfo) {
  const mounts = (core.HostConfig.Mounts ?? []) as Array<{ Target?: string }>;
  return [coreAppSocketsTarget, corePackagesTarget].every((target) =>
    mounts.some((mount) => mount.Target === target),
  );
}

// And only those folders: a Docker too old to know subpaths ignores them and
// mounts the manager's whole volume there. Recreating wouldn't help, so this
// only decides whether the manager says it can run apps.
export function hasOnlyAppFolders(core: ContainerInfo) {
  const mounts = (core.HostConfig.Mounts ?? []) as Array<{
    Target?: string;
    VolumeOptions?: { Subpath?: string };
  }>;
  const subpath = (target: string) =>
    mounts.find((mount) => mount.Target === target)?.VolumeOptions?.Subpath;
  return (
    subpath(coreAppSocketsTarget) === "sockets" &&
    subpath(corePackagesTarget) === "packages"
  );
}

// Makes sure the core exists and runs. It never changes the core's image:
// that only happens through an update, with its backup and health check.
export async function reconcileCore(options: {
  docker: DockerClientLike;
  image: string;
  log: Log;
}) {
  const { docker, image, log } = options;
  await ensureNetwork(docker, sanctumNetworkName);
  await ensureVolume(docker, coreVolumeName);
  await ensureVolume(docker, socketVolumeName);

  const existing = await inspectContainer(docker, coreContainerName);
  if (existing) {
    assertManaged(
      { labels: existing.Config.Labels, name: coreContainerName },
      coreRole,
    );
    if (hasAppFolders(existing)) {
      const started = await startExistingContainer({
        container: existing,
        docker,
        log,
        networkName: sanctumNetworkName,
      });
      if (started) {
        return existing.Image;
      }
    } else {
      // Once, and with the image it has. Its data is in its volume.
      log(`Recreating ${coreContainerName} with the folders apps need`);
      const container = docker.getContainer(existing.Id);
      await container.stop({ t: 30 }).catch(() => undefined);
      await container.remove({ force: true });
    }
  }

  const desiredImage = existing?.Image ?? image;
  log(`Creating ${coreContainerName} from ${desiredImage}`);
  await ensureImage(docker, desiredImage);
  await createCoreContainer(docker, desiredImage);
  await docker.getContainer(coreContainerName).start();
  return (await inspectContainer(docker, coreContainerName))!.Image;
}
