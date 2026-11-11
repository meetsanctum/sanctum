import { createHash } from "node:crypto";

import { sanctumNetworkName } from "../core-container.js";
import {
  assertManaged,
  ensureNetwork,
  ensureVolume,
  managedLabels,
  startExistingContainer,
  type Log,
} from "../docker-resources.js";
import {
  ensureImage,
  inspectContainer,
  type ContainerCreateOptions,
  type DockerClientLike,
} from "../docker.js";
import { restartPolicy, stack, stacked } from "../stack.js";

// A service's container, kept like the core's: on the `sanctum` network,
// restarted by Docker, and labelled so the manager never takes over a
// container a person made. Its definition is hashed into a label, so a new
// image, a new client or another coordinator replaces the container, and an
// unchanged one is left running.

export type ServiceSpec = {
  image: string;
  env?: string[];
  cmd?: string[];
  volumes?: Array<{ name: string; target: string }>;
  // Host devices, such as a Zigbee coordinator.
  devices?: Array<{ host: string; container: string }>;
};

const definitionLabel = "sanctum.definition";

export function serviceContainerName(service: string) {
  return stacked(`sanctum-${service}`);
}

export function serviceContainerOptions(
  service: string,
  spec: ServiceSpec,
): ContainerCreateOptions {
  const options: ContainerCreateOptions = {
    name: serviceContainerName(service),
    Image: spec.image,
    ...(spec.env ? { Env: spec.env } : {}),
    ...(spec.cmd ? { Cmd: spec.cmd } : {}),
    Labels: managedLabels(service),
    HostConfig: {
      Binds: (spec.volumes ?? []).map(
        (volume) => `${volume.name}:${volume.target}`,
      ),
      ...(spec.devices
        ? {
            Devices: spec.devices.map((device) => ({
              PathOnHost: device.host,
              PathInContainer: device.container,
              CgroupPermissions: "rwm",
            })),
          }
        : {}),
      RestartPolicy: restartPolicy,
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "10m", "max-file": "3" },
      },
    },
    NetworkingConfig: { EndpointsConfig: { [sanctumNetworkName]: {} } },
  };
  options.Labels![definitionLabel] = createHash("sha256")
    .update(JSON.stringify(options))
    .digest("hex")
    .slice(0, 16);
  return options;
}

export async function inspectService(
  docker: DockerClientLike,
  service: string,
) {
  const name = serviceContainerName(service);
  const existing = await inspectContainer(docker, name);
  if (existing) {
    assertManaged({ labels: existing.Config.Labels, name }, service);
  }
  return existing;
}

export async function stopAndRemove(docker: DockerClientLike, name: string) {
  const container = docker.getContainer(name);
  // A graceful stop lets the broker save its messages and Zigbee2MQTT its
  // state; a container that is not running answers with an error.
  await container.stop({ t: 10 }).catch(() => undefined);
  await container.remove({ force: true });
}

// Service images are not the manager's to keep once nothing runs them.
export async function removeUnusedImage(
  docker: DockerClientLike,
  imageId: string,
) {
  // Another stack on this Docker may want it next.
  if (stack) return;
  const containers = await docker.listContainers({ all: true });
  if (containers.some((container) => container.ImageID === imageId)) {
    return;
  }
  await docker
    .getImage(imageId)
    .remove()
    .catch(() => undefined);
}

// Makes the service's container match its spec and run. Returns the running
// container. The image it replaces stays: a change of image (image-change.ts)
// may yet go back to it.
export async function reconcileServiceContainer(options: {
  docker: DockerClientLike;
  service: string;
  spec: ServiceSpec;
  log: Log;
}) {
  const { docker, service, spec, log } = options;
  const desired = serviceContainerOptions(service, spec);
  const name = desired.name;
  const existing = await inspectService(docker, service);
  if (existing) {
    if (
      existing.Config.Labels?.[definitionLabel] ===
      desired.Labels?.[definitionLabel]
    ) {
      const started = await startExistingContainer({
        container: existing,
        docker,
        log,
        networkName: sanctumNetworkName,
      });
      if (started) {
        return (await inspectContainer(docker, name))!;
      }
    } else {
      // Pull first, so a failed pull leaves the old container running.
      await ensureImage(docker, spec.image);
      log(`Replacing ${name}: its definition changed`);
      await stopAndRemove(docker, name);
    }
  }

  await ensureNetwork(docker, sanctumNetworkName);
  for (const volume of spec.volumes ?? []) {
    await ensureVolume(docker, volume.name);
  }
  await ensureImage(docker, spec.image);
  log(`Creating ${name} from ${spec.image}`);
  await docker.createContainer(desired);
  await docker.getContainer(name).start();
  return (await inspectContainer(docker, name))!;
}

// Stops a service that cannot run yet, such as Zigbee2MQTT without its
// coordinator, instead of letting Docker restart it in a loop.
export async function stopServiceContainer(options: {
  docker: DockerClientLike;
  service: string;
  log: Log;
}) {
  const { docker, service, log } = options;
  const existing = await inspectService(docker, service);
  if (existing?.State.Running) {
    log(`Stopping ${serviceContainerName(service)}`);
    await docker.getContainer(existing.Id).stop({ t: 10 });
  }
}

// Removes a service nothing needs any more. Its data volume stays, so a
// Zigbee network survives the app being switched off and on.
export async function removeServiceContainer(options: {
  docker: DockerClientLike;
  service: string;
  log: Log;
}) {
  const { docker, service, log } = options;
  const existing = await inspectService(docker, service);
  if (!existing) {
    return;
  }
  log(`Removing ${serviceContainerName(service)}`);
  await stopAndRemove(docker, existing.Id);
  await removeUnusedImage(docker, existing.Image);
}
