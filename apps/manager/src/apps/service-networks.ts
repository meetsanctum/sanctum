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

// An app that uses a service over HTTP reaches it on a network of its own:
// internal and shared only with that service. Being on the network grants
// access. The service joins only the networks of the apps that hold it and
// leaves an app's network when its grant is revoked.

const appLabel = "sanctum.app.service-network";
const serviceLabel = "sanctum.service";
const maxRemoveAttempts = 3;

export function serviceNetworkName(app: string, service: string) {
  return stacked(`sanctum-app-${app}-${service}`);
}

/** The broker and HTTP networks the staged app's manifest asks for. */
export async function appServiceNetworks(packageDir: string) {
  const text = await readFile(
    join(packageDir, "sanctum-app.json"),
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const { permissions } = (text === null ? {} : JSON.parse(text)) as {
    permissions?: { id: string }[];
  };
  const servicePrefix = "services:";
  const services = new Set(
    (permissions ?? [])
      .filter(({ id }) => id.startsWith(servicePrefix))
      .map(({ id }) => id.slice(servicePrefix.length)),
  );
  let usesBroker = false;
  const httpServices: string[] = [];
  for (const name of services) {
    const definition = findService(name);
    if (definition?.mqttTopics?.length) usesBroker = true;
    if (definition?.url) httpServices.push(name);
  }
  return { usesBroker, httpServices };
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
  return networks.flatMap(({ Name: name, Labels: labels }) => {
    const app = labels?.[appLabel];
    return app && isOurs(labels) && name === serviceNetworkName(app, service)
      ? [{ name, app }]
      : [];
  });
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
  const networks = await networksOf(docker, service);
  // Take access away before attempting connections that can fail independently.
  for (const { name, app } of networks) {
    if (apps.includes(app) || !container.NetworkSettings?.Networks?.[name]) {
      continue;
    }
    log(`Disconnecting ${containerName(container)} from ${name}`);
    await docker
      .getNetwork(name)
      .disconnect({ Container: container.Id, Force: true })
      .catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
  }
  for (const { name, app } of networks) {
    if (!apps.includes(app)) continue;
    const inspected = await inspectNetwork(docker, name);
    if (!inspected) continue;
    assertManaged({ labels: inspected.Labels, name: `${name} network` });
    if (inspected.Internal !== true) {
      throw new Error(`The ${name} network reaches beyond its containers`);
    }
    if (
      inspected.Labels?.[appLabel] !== app ||
      inspected.Labels[serviceLabel] !== service
    ) {
      throw new Error(`Refusing to use ${name} network with unexpected labels`);
    }
    await ensureContainerNetwork(docker, container, name, log).catch(
      async (error: unknown) => {
        if (!isNotFound(error) || (await inspectNetwork(docker, name))) {
          throw error;
        }
      },
    );
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
