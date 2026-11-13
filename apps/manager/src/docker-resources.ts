import {
  containerName,
  isNotFound,
  isStaleDockerSandboxError,
  managedLabel,
  roleLabel,
  type ContainerInfo,
  type DockerClientLike,
  type Labels,
} from "./docker.js";
import { isOurs, stackLabels } from "./stack.js";

// The manager only touches Docker resources it labelled itself, so a
// same-name container or volume a person created by hand is refused instead
// of being taken over.

export type Log = (message: string) => void;

export function managedLabels(role: string): Labels {
  return { [managedLabel]: "true", [roleLabel]: role, ...stackLabels() };
}

export function assertManaged(
  resource: { labels?: Labels | null; name: string },
  role?: string,
) {
  const labels = resource.labels ?? {};
  if (
    labels[managedLabel] !== "true" ||
    !isOurs(labels) ||
    (role !== undefined && labels[roleLabel] !== role)
  ) {
    throw new Error(`Refusing to manage unlabelled ${resource.name}`);
  }
}

// An internal one reaches nothing beyond the containers on it, and one of that
// name that isn't is refused rather than used.
export async function ensureNetwork(
  docker: DockerClientLike,
  name: string,
  options: { internal?: boolean; labels?: Labels } = {},
) {
  let inspected;
  try {
    inspected = await docker.getNetwork(name).inspect();
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    await docker.createNetwork({
      Name: name,
      CheckDuplicate: true,
      ...(options.internal ? { Internal: true } : {}),
      Labels: {
        ...options.labels,
        [managedLabel]: "true",
        ...stackLabels(),
      },
    });
    return;
  }
  assertManaged({ labels: inspected.Labels, name: `${name} network` });
  if (options.internal && inspected.Internal !== true) {
    throw new Error(`The ${name} network reaches beyond its containers`);
  }
  if (
    Object.entries(options.labels ?? {}).some(
      ([key, value]) => inspected.Labels?.[key] !== value,
    )
  ) {
    throw new Error(`Refusing to use ${name} network with unexpected labels`);
  }
}

export async function ensureVolume(docker: DockerClientLike, name: string) {
  try {
    const inspected = await docker.getVolume(name).inspect();
    assertManaged({ labels: inspected.Labels, name: `${name} volume` });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    await docker.createVolume({
      Name: name,
      Labels: { [managedLabel]: "true", ...stackLabels() },
    });
  }
}

export async function ensureContainerNetwork(
  docker: DockerClientLike,
  container: ContainerInfo,
  networkName: string,
  log: Log,
) {
  const network = container.NetworkSettings?.Networks?.[networkName];
  if (network?.EndpointID || network?.IPAddress) {
    return;
  }

  const name = containerName(container);
  log(`Connecting ${name} to ${networkName}`);
  const dockerNetwork = docker.getNetwork(networkName);
  if (network) {
    await dockerNetwork
      .disconnect({ Container: name, Force: true })
      .catch(() => undefined);
  }
  await dockerNetwork.connect({ Container: name });
}

// Starts an existing container, reconnecting it to its network first. Returns
// false after removing a container whose network sandbox Docker lost (which
// happens after some daemon restarts), so the caller recreates it.
export async function startExistingContainer(options: {
  container: ContainerInfo;
  docker: DockerClientLike;
  log: Log;
  networkName?: string;
}) {
  const name = containerName(options.container);
  try {
    if (options.networkName) {
      await ensureContainerNetwork(
        options.docker,
        options.container,
        options.networkName,
        options.log,
      );
    }
    if (!options.container.State.Running) {
      options.log(`Starting ${name}`);
      await options.docker.getContainer(name).start();
    }
    return true;
  } catch (error) {
    if (!isStaleDockerSandboxError(error)) {
      throw error;
    }
    options.log(
      `Recreating ${name} after Docker reported a stale network sandbox`,
    );
    await options.docker
      .getContainer(name)
      .remove({ force: true })
      .catch(() => undefined);
    return false;
  }
}
