import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertManaged,
  ensureContainerNetwork,
  ensureNetwork,
  type Log,
} from "../docker-resources.js";
import {
  containerName,
  errorMessage,
  isNotFound,
  managedLabel,
  type ContainerInfo,
  type DockerClientLike,
} from "../docker.js";
import { inspectService } from "../services/containers.js";
import { findService } from "../services/registry.js";
import { isOurs, stacked } from "../stack.js";

// An app that uses a service over HTTP, as the Ollama app uses Ollama,
// reaches it on a network of its own: internal, so nothing on it reaches
// beyond, and shared only with that service. No account limits what the app
// may ask the service, so being on the network is what lets it in: the
// service joins only the networks of the apps that hold it, and leaves one as
// soon as its app stops holding it.

const appLabel = "sanctum.app.service-network";
const serviceLabel = "sanctum.service";
const maxRemoveAttempts = 3;

export function serviceNetworkName(app: string, service: string) {
  return stacked(`sanctum-app-${app}-${service}`);
}

/** The services the package staged in this folder asks for, as its manifest says. */
export async function declaredServices(packageDir: string) {
  const text = await readFile(
    join(packageDir, "sanctum-app.json"),
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return [];
  const { permissions } = JSON.parse(text) as {
    permissions?: { id: string }[];
  };
  return (permissions ?? [])
    .filter(({ id }) => id.startsWith("services:"))
    .map(({ id }) => id.slice("services:".length));
}

/** The services it reaches over HTTP that the package asks for. */
export async function httpServices(packageDir: string) {
  return (await declaredServices(packageDir)).filter(
    (name) => findService(name)?.url !== undefined,
  );
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

/** The app's network for a service, made if it isn't there. */
export async function serviceNetworkFor(
  docker: DockerClientLike,
  app: string,
  service: string,
) {
  const name = serviceNetworkName(app, service);
  await ensureNetwork(docker, name, {
    internal: true,
    labels: { [appLabel]: app, [serviceLabel]: service },
  });
  return name;
}

// The networks the manager made for apps to reach a service.
async function networksOf(docker: DockerClientLike, service: string) {
  const networks = await docker.listNetworks({
    filters: {
      label: [appLabel, `${serviceLabel}=${service}`, `${managedLabel}=true`],
    },
  });
  const found: { name: string; app: string }[] = [];
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
    const app = inspected.Labels?.[appLabel];
    if (app) found.push({ name: network.Name, app });
  }
  return found;
}

/**
 * The service joins the networks of the apps that hold it and leaves the
 * others, which no longer reach it.
 */
export async function syncServiceNetworks(
  docker: DockerClientLike,
  service: string,
  container: ContainerInfo,
  apps: readonly string[],
  log: Log,
) {
  for (const network of await networksOf(docker, service)) {
    const joined = container.NetworkSettings?.Networks?.[network.name];
    if (apps.includes(network.app)) {
      await ensureContainerNetwork(docker, container, network.name, log);
    } else if (joined) {
      log(`Disconnecting ${containerName(container)} from ${network.name}`);
      await docker
        .getNetwork(network.name)
        .disconnect({ Container: container.Id, Force: true })
        .catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
    }
  }
}

/** Whether a container is still on the app's network for a service. */
export function reaches(
  container: ContainerInfo | null,
  app: string,
  service: string,
) {
  return (
    container?.NetworkSettings?.Networks?.[serviceNetworkName(app, service)] !==
    undefined
  );
}

/** Releases the app's networks for services once its container is gone. */
export async function removeServiceNetworks(
  docker: DockerClientLike,
  app: string,
  log: Log,
) {
  const networks = await docker.listNetworks({
    filters: { label: [`${appLabel}=${app}`, `${managedLabel}=true`] },
  });
  for (const { Name: name, Labels: labels } of networks) {
    if (!isOurs(labels) || labels?.[appLabel] !== app) continue;
    const service = labels[serviceLabel];
    const network = docker.getNetwork(name);
    for (let attempt = 1; ; attempt++) {
      const container = service ? await inspectService(docker, service) : null;
      if (container?.NetworkSettings?.Networks?.[name]) {
        await network
          .disconnect({ Container: container.Id, Force: true })
          .catch((error: unknown) => {
            if (!isNotFound(error)) throw error;
          });
      }
      log(`Removing ${name}`);
      try {
        await network.remove();
        break;
      } catch (error) {
        if (isNotFound(error)) break;
        // The service can be made again and join before Docker removes it.
        if (
          attempt >= maxRemoveAttempts ||
          !errorMessage(error).includes("has active endpoints")
        ) {
          throw error;
        }
      }
    }
  }
}
