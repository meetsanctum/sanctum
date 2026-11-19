import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertManaged,
  ensureContainerNetwork,
  ensureNetwork,
  type Log,
} from "../docker-resources.js";
import {
  errorMessage,
  isNotFound,
  managedLabel,
  type ContainerInfo,
  type DockerClientLike,
} from "../docker.js";
import { inspectService } from "../services/containers.js";
import { findService } from "../services/registry.js";
import { isOurs, stacked } from "../stack.js";

// An app that uses a service through the broker reaches the broker, and
// nothing else, on a network of its own: internal, so nothing on it reaches
// beyond, and shared only with the broker. Every other app has no network at
// all. Its broker account still limits it to its service's topics.

const brokerLabel = "sanctum.app.broker";
const broker = "mosquitto";
const maxRemoveAttempts = 3;

export function brokerNetworkName(app: string) {
  return stacked(`sanctum-app-${app}-broker`);
}

function inspectNetwork(docker: DockerClientLike, name: string) {
  return docker
    .getNetwork(name)
    .inspect()
    .catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
}

// Whether the package staged in this folder asks for a service it reaches
// through the broker, as its manifest says.
export async function usesBroker(packageDir: string) {
  const text = await readFile(
    join(packageDir, "sanctum-app.json"),
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return false;
  const { permissions } = JSON.parse(text) as {
    permissions?: { id: string }[];
  };
  return (permissions ?? []).some(
    ({ id }) =>
      id.startsWith("services:") &&
      (findService(id.slice("services:".length))?.mqttTopics?.length ?? 0) > 0,
  );
}

/** The app's network, made if it isn't there, with the broker on it if it runs. */
export async function brokerNetworkFor(
  docker: DockerClientLike,
  app: string,
  log: Log,
) {
  const name = brokerNetworkName(app);
  await ensureNetwork(docker, name, {
    internal: true,
    labels: { [brokerLabel]: app },
  });
  const running = await inspectService(docker, broker);
  if (running) await ensureContainerNetwork(docker, running, name, log);
  return name;
}

/** The broker joins every app's network, as when its container is made again. */
export async function joinAppNetworks(
  docker: DockerClientLike,
  container: ContainerInfo,
  log: Log,
) {
  const networks = await docker.listNetworks({
    filters: { label: [brokerLabel, `${managedLabel}=true`] },
  });
  for (const network of networks) {
    if (!isOurs(network.Labels)) continue;
    const inspected = await inspectNetwork(docker, network.Name);
    if (!inspected) continue;
    assertManaged({
      labels: inspected.Labels,
      name: `${network.Name} network`,
    });
    if (inspected.Internal !== true) {
      throw new Error(
        `The ${network.Name} network reaches beyond its containers`,
      );
    }
    await ensureContainerNetwork(docker, container, network.Name, log).catch(
      async (error: unknown) => {
        // Docker also reports 404 when the broker container is gone.
        if (
          !isNotFound(error) ||
          (await inspectNetwork(docker, network.Name))
        ) {
          throw error;
        }
      },
    );
  }
}

/** Releases the app's network once its containers no longer use it. */
export async function removeBrokerNetwork(
  docker: DockerClientLike,
  app: string,
  log: Log,
) {
  const name = brokerNetworkName(app);
  const inspected = await inspectNetwork(docker, name);
  if (!inspected) return;
  assertManaged({ labels: inspected.Labels, name: `${name} network` });
  if (inspected.Labels?.[brokerLabel] !== app) {
    throw new Error(
      `Refusing to remove ${name} network with unexpected labels`,
    );
  }
  const network = docker.getNetwork(name);
  for (let attempt = 1; ; attempt++) {
    const container = await inspectService(docker, broker);
    if (container?.NetworkSettings?.Networks?.[name]) {
      // The broker can be replaced after inspection. Removal still checks
      // whether the network has any endpoints.
      await network
        .disconnect({ Container: container.Id, Force: true })
        .catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
    }
    log(`Removing ${name}`);
    try {
      await network.remove();
      return;
    } catch (error) {
      if (isNotFound(error)) return;
      // A replacement broker can join before Docker removes the network.
      if (
        attempt >= maxRemoveAttempts ||
        !errorMessage(error).includes("has active endpoints")
      ) {
        throw error;
      }
    }
  }
}

/** Whether a service is the broker, which joins apps' networks. */
export const isBroker = (service: string) => service === broker;
