import { createServer } from "node:net";

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
  errorMessage,
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
// Smart speakers fetch the announcements they play from the core here, over
// plain HTTP, since they check HTTPS only against public roots. It's
// published on IPv4 only, so the home's network reaches it and a public IPv6
// address doesn't.
export const speakerPort = 4180;
// The manager's socket lives in this volume, which Compose creates and mounts
// into the manager; the core is the only other container that mounts it.
export const socketVolumeName = stacked("sanctum-manager-socket");
export const socketDirectory = "/run/sanctum";
// Speech-to-Phrase and the core share only this socket volume.
export const speechSocketVolumeName = stacked("sanctum-speech-socket");
export const speechSocketDirectory = "/run/sanctum-speech";
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

// Where the host publishes the speakers' port: 4180 on a host, a stack's own
// port where it has one, and nowhere on a stack that gives none.
function publishedSpeakerPort() {
  return stackCore ? (stackCore.speakerPort ?? null) : speakerPort;
}

const speakerPortFallback = "sanctum.core.speaker-port-unavailable";
const speechSocketBind = `${speechSocketVolumeName}:${speechSocketDirectory}:ro`;

export function coreContainerOptions(
  image: string,
  withoutSpeakers = false,
): ContainerCreateOptions {
  const published = withoutSpeakers ? null : publishedSpeakerPort();
  return {
    name: coreContainerName,
    Image: image,
    Labels: {
      ...managedLabels(coreRole),
      ...(withoutSpeakers && { [speakerPortFallback]: "true" }),
      // Keep the requested mounts: Docker Desktop rewrites their source
      // paths inside its VM, so its inspected Binds cannot be compared to
      // paths on the Mac when the stack starts again.
      ...(stackCore
        ? { "sanctum.stack.core-binds": stackCore.binds.join(";") }
        : {}),
    },
    Env: [
      `CORE_ALLOWED_ORIGINS=${clientOrigins.join(",")}`,
      ...(published === null
        ? []
        : [
            `CORE_SPEAKER_PORT=${speakerPort}`,
            // The port in the addresses it gives speakers.
            `CORE_SPEAKER_PUBLISHED_PORT=${published}`,
          ]),
      ...(stackCore?.env ?? []),
      ...(withoutSpeakers ? ["CORE_SPEAKER_PORT=0"] : []),
    ],
    ExposedPorts: {
      [`${corePort}/tcp`]: {},
      ...(published === null ? {} : { [`${speakerPort}/tcp`]: {} }),
    },
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
      // An init process runs first and takes in what the health check leaves:
      // BusyBox's wget doesn't wait for the helper it starts for HTTPS, and
      // Node, were it first, reaps nothing, so each check would leave a zombie.
      Init: true,
      Binds: [
        `${coreVolumeName}:/data`,
        `${socketVolumeName}:${socketDirectory}`,
        speechSocketBind,
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
        ...(published === null
          ? {}
          : {
              [`${speakerPort}/tcp`]: [
                { HostIp: "0.0.0.0", HostPort: String(published) },
              ],
            }),
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

function speakerPortConflict(error: unknown) {
  const port = publishedSpeakerPort();
  if (port === null) return false;
  const message = errorMessage(error);
  return (
    new RegExp(`:${port}(?!\\d)`).test(message) &&
    /port is already allocated|address already in use/i.test(message)
  );
}

async function speakerPortAvailable(docker: DockerClientLike, port: number) {
  // Docker can reserve a published port without a userspace listener.
  const containers = await docker.listContainers();
  if (
    containers.some(({ Ports }) =>
      Ports?.some(
        (binding) => binding.Type === "tcp" && binding.PublicPort === port,
      ),
    )
  )
    return false;
  return new Promise<boolean>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    probe.listen(port, "0.0.0.0", () => probe.close(() => resolve(true)));
  });
}

export async function startCoreContainer(options: {
  docker: DockerClientLike;
  image: string;
  log: Log;
  withoutSpeakers?: boolean;
}) {
  const { docker, image, log, withoutSpeakers = false } = options;
  await ensureVolume(docker, speechSocketVolumeName);
  const container = docker.getContainer(coreContainerName);
  await docker.createContainer(coreContainerOptions(image, withoutSpeakers));
  try {
    await container.start();
  } catch (error) {
    if (withoutSpeakers || !speakerPortConflict(error)) throw error;
    log(
      `The speaker port is in use. Starting ${coreContainerName} without announcements.`,
    );
    await container.remove({ force: true });
    await docker.createContainer(coreContainerOptions(image, true));
    await docker.getContainer(coreContainerName).start();
  }
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

// Whether a core's container starts with an init process. An older manager's
// update makes one without, as with the folders, and a container only gets
// one when it is created.
export function hasInit(core: ContainerInfo) {
  return core.HostConfig.Init === true;
}

// Whether a core's container publishes the port speakers fetch announcements
// from, where this manager publishes one. A core made before the port, or by
// an older manager's update, has none, and a container only gets one when it
// is created.
export function hasSpeakerPort(core: ContainerInfo) {
  if (publishedSpeakerPort() === null) return true;
  const bindings = (core.HostConfig.PortBindings ?? {}) as Record<
    string,
    unknown[] | null
  >;
  return (bindings[`${speakerPort}/tcp`]?.length ?? 0) > 0;
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
  portAvailable?: (port: number) => Promise<boolean>;
}) {
  const { docker, image, log } = options;
  await ensureNetwork(docker, sanctumNetworkName);
  await ensureVolume(docker, coreVolumeName);
  await ensureVolume(docker, socketVolumeName);

  const existing = await inspectContainer(docker, coreContainerName);
  let withoutSpeakers = false;
  if (existing) {
    assertManaged(
      { labels: existing.Config.Labels, name: coreContainerName },
      coreRole,
    );
    const published = publishedSpeakerPort();
    if (
      published !== null &&
      existing.Config.Labels?.[speakerPortFallback] === "true"
    ) {
      const available =
        options.portAvailable ?? ((port) => speakerPortAvailable(docker, port));
      try {
        withoutSpeakers = !(await available(published));
      } catch (error) {
        log(`Could not check the speaker port: ${errorMessage(error)}`);
        withoutSpeakers = true;
      }
    }
    const binds = existing.HostConfig.Binds as string[] | null | undefined;
    const lacks = !hasAppFolders(existing)
      ? "the folders apps need"
      : !hasInit(existing)
        ? "an init process"
        : !withoutSpeakers && !hasSpeakerPort(existing)
          ? "the port speakers fetch sound from"
          : !binds?.includes(speechSocketBind)
            ? "the speech socket"
            : null;
    if (!lacks) {
      try {
        const started = await startExistingContainer({
          container: existing,
          docker,
          log,
          networkName: sanctumNetworkName,
        });
        if (started) return existing.Image;
      } catch (error) {
        if (withoutSpeakers || !speakerPortConflict(error)) throw error;
        log(
          `The speaker port is in use. Starting ${coreContainerName} without announcements.`,
        );
        await docker.getContainer(existing.Id).remove({ force: true });
        withoutSpeakers = true;
      }
    } else {
      // Once, and with the image it has. Its data is in its volume.
      await ensureVolume(docker, speechSocketVolumeName);
      log(`Recreating ${coreContainerName} with ${lacks}`);
      const container = docker.getContainer(existing.Id);
      await container.stop({ t: 30 }).catch(() => undefined);
      await container.remove({ force: true });
    }
  }

  const desiredImage = existing?.Image ?? image;
  log(`Creating ${coreContainerName} from ${desiredImage}`);
  await ensureImage(docker, desiredImage);
  await startCoreContainer({
    docker,
    image: desiredImage,
    log,
    withoutSpeakers,
  });
  return (await inspectContainer(docker, coreContainerName))!.Image;
}
