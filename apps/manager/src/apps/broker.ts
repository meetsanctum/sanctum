import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ensureContainerNetwork,
  ensureNetwork,
  type Log,
} from "../docker-resources.js";
import {
  inspectContainer,
  type ContainerInfo,
  type DockerClientLike,
} from "../docker.js";
import { serviceContainerName } from "../services/containers.js";
import { findService } from "../services/registry.js";
import { isOurs, stacked } from "../stack.js";

// An app that uses a service through the broker reaches the broker, and
// nothing else, on a network of its own: internal, so nothing on it reaches
// beyond, and shared only with the broker. Every other app has no network at
// all. Its broker account still limits it to its service's topics.

const brokerLabel = "sanctum.app.broker";
const broker = "mosquitto";

export function brokerNetworkName(app: string) {
  return stacked(`sanctum-app-${app}-broker`);
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
  const running = await inspectContainer(docker, serviceContainerName(broker));
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
    filters: { label: [brokerLabel] },
  });
  for (const network of networks) {
    if (!isOurs(network.Labels)) continue;
    await ensureContainerNetwork(docker, container, network.Name, log);
  }
}

/** Whether a service is the broker, which joins apps' networks. */
export const isBroker = (service: string) => service === broker;
