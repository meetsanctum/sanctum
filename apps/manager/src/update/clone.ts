import { isDeepStrictEqual } from "node:util";

import type {
  ContainerCreateOptions,
  ContainerInfo,
  ImageInfo,
} from "../docker.js";

// Settings an image provides. A container's inspected config mixes them with
// what its creator set, so a copy drops the image's values and lets the new
// image supply its own (its version, command and defaults).
const imageDefaults = [
  "Cmd",
  "Entrypoint",
  "WorkingDir",
  "User",
  "Healthcheck",
  "StopSignal",
] as const;

function withoutImageEntries<T>(
  values: Record<string, T> | null | undefined,
  image: Record<string, T> | null | undefined,
) {
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(
      ([key, value]) => !isDeepStrictEqual(image?.[key], value),
    ),
  );
}

// Recreates a container's settings for a new image, as `docker run` with the
// same options would. Used for the manager, which Compose created.
export function cloneContainerOptions(
  container: ContainerInfo,
  image: ImageInfo | null,
  newImage: string,
  name: string,
): ContainerCreateOptions {
  const imageConfig = image?.Config ?? {};
  const {
    Hostname: _hostname,
    Domainname: _domainname,
    Image: _image,
    Env,
    Labels,
    ExposedPorts,
    Volumes,
    ...config
  } = container.Config;

  for (const key of imageDefaults) {
    if (isDeepStrictEqual(config[key], imageConfig[key])) {
      delete config[key];
    }
  }

  const imageEnv = new Set(imageConfig.Env ?? []);
  const networkMode = container.HostConfig.NetworkMode ?? "default";
  const networks = container.NetworkSettings?.Networks ?? {};
  const ownNetwork =
    networkMode === "host" ||
    networkMode === "none" ||
    networkMode.startsWith("container:");

  return {
    ...config,
    name,
    Image: newImage,
    Env: (Env ?? []).filter((entry) => !imageEnv.has(entry)),
    Labels: withoutImageEntries(Labels, imageConfig.Labels),
    ExposedPorts: withoutImageEntries(
      ExposedPorts as Record<string, object> | undefined,
      imageConfig.ExposedPorts as Record<string, object> | undefined,
    ),
    Volumes: withoutImageEntries(
      Volumes as Record<string, object> | undefined,
      imageConfig.Volumes as Record<string, object> | undefined,
    ),
    HostConfig: container.HostConfig,
    ...(ownNetwork
      ? {}
      : {
          NetworkingConfig: {
            EndpointsConfig: Object.fromEntries(
              Object.entries(networks).map(([network, endpoint]) => [
                network,
                {
                  Aliases: (endpoint.Aliases ?? []).filter(
                    (alias) => !container.Id.startsWith(alias),
                  ),
                },
              ]),
            ),
          },
        }),
  };
}
