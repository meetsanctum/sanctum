import type { ManagerConfig } from "./config.js";

export type Service = "core" | "manager";

export type Release = {
  // What the update is to: a dev tag, or the channel itself.
  version: string;
  images: Record<Service, string>;
};

export const devVersion = /^dev-[0-9a-z][0-9a-z.-]{0,100}$/;

type ReleaseConfig = Pick<
  ManagerConfig,
  "channel" | "devRegistry" | "imageOwner" | "version"
>;

export class ReleaseError extends Error {}

function imageFor(config: ReleaseConfig, service: Service, tag: string) {
  const repository =
    config.channel === "dev"
      ? config.devRegistry
      : `ghcr.io/${config.imageOwner}`;
  return `${repository}/sanctum-${service}:${tag}`;
}

// Resolves an update request to the images it installs. Stable and edge hosts
// follow their channel's tag; only a dev host takes dev builds, and only from
// its own registry, so the dev channel never applies to a household host.
export function resolveRelease(
  config: ReleaseConfig,
  version?: string,
): Release {
  if (config.channel !== "dev") {
    if (version !== undefined && version !== config.channel) {
      throw new ReleaseError(
        `A ${config.channel} host follows its channel and takes no version`,
      );
    }
    return release(config, config.channel);
  }
  if (version === undefined || !devVersion.test(version)) {
    throw new ReleaseError(
      "A dev host updates to a dev-<commit> build pushed to its registry",
    );
  }
  return release(config, version);
}

function release(config: ReleaseConfig, tag: string): Release {
  return {
    version: tag,
    images: {
      core: imageFor(config, "core", tag),
      manager: imageFor(config, "manager", tag),
    },
  };
}

// The core image a new host starts with: its channel's, or on a dev host the
// build the manager itself came from.
export function initialCoreImage(config: ReleaseConfig) {
  const tag = config.channel === "dev" ? config.version : config.channel;
  return imageFor(config, "core", tag);
}
