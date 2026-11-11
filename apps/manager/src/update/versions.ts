import { z } from "zod";

import type { Channel, ManagerConfig } from "../config.js";
import { imageServiceLabel } from "../docker.js";
import { devVersion, type Service } from "../release.js";
import type { Fetch } from "../socket.js";
import { createRegistry } from "./registry.js";

// The versions a host can update to, for Settings → System. A stable or edge host
// follows its channel's tag, so that tag is all there is. A dev host takes the
// dev builds pushed to its own registry, newest first: only those whose core and
// manager images are both there.

export type AvailableVersion = {
  version: string;
  // When the build was made, from its core image.
  builtAt?: string;
};

export type Versions = {
  channel: Channel;
  versions: AvailableVersion[];
};

// The newest builds are plenty to choose from, and each one costs the
// registry a few requests.
const listedBuilds = 20;

const imageConfig = z.object({
  architecture: z.string(),
  os: z.string(),
  created: z.string().optional(),
  config: z
    .object({ Labels: z.record(z.string(), z.string()).nullish() })
    .optional(),
});

// Docker's names for the architectures Node reports.
function dockerArchitecture(arch: string) {
  return arch === "x64" ? "amd64" : arch;
}

export function createVersionList(options: {
  config: Pick<ManagerConfig, "channel" | "devRegistry">;
  fetch?: Fetch;
  arch?: string;
}) {
  const { config } = options;
  const architecture = dockerArchitecture(options.arch ?? process.arch);
  // Image configs never change for a digest.
  const configs = new Map<string, z.infer<typeof imageConfig>>();

  const registry = createRegistry({
    address: config.devRegistry,
    fetch: options.fetch,
  });

  const tags = async (service: Service) =>
    (await registry.tags(`sanctum-${service}`)).filter((tag) =>
      devVersion.test(tag),
    );

  // A service image's config for a tag, through an image index when the
  // build has one, picking this host's platform.
  async function serviceConfig(service: Service, tag: string) {
    const repository = `sanctum-${service}`;
    let { manifest: found } = await registry.manifest(repository, tag);
    if ("manifests" in found) {
      const match = found.manifests.find(
        (entry) =>
          entry.platform?.os === "linux" &&
          entry.platform.architecture === architecture,
      );
      if (!match) {
        return undefined;
      }
      ({ manifest: found } = await registry.manifest(repository, match.digest));
      if ("manifests" in found) {
        return undefined;
      }
    }
    const { digest } = found.config;
    let image = configs.get(digest);
    if (!image) {
      ({ data: image } = await registry.json(
        `${repository}/blobs/${digest}`,
        imageConfig,
      ));
      configs.set(digest, image);
    }
    return image.os === "linux" &&
      image.architecture === architecture &&
      image.config?.Labels?.[imageServiceLabel] === service
      ? image
      : undefined;
  }

  async function build(tag: string): Promise<AvailableVersion | undefined> {
    const image = await serviceConfig("core", tag);
    if (!image || !(await serviceConfig("manager", tag))) {
      return undefined;
    }
    return {
      version: tag,
      ...(image.created ? { builtAt: image.created } : {}),
    };
  }

  // Every build with both its images, newest first.
  async function builds() {
    const [core, manager] = await Promise.all([tags("core"), tags("manager")]);
    const both = core.filter((tag) => manager.includes(tag));
    const found: AvailableVersion[] = [];
    // A few at a time, to spare a Pi's registry.
    for (let start = 0; start < both.length; start += 6) {
      const batch = await Promise.all(both.slice(start, start + 6).map(build));
      found.push(...batch.filter((each) => each !== undefined));
    }
    const time = (build: AvailableVersion) =>
      build.builtAt ? Date.parse(build.builtAt) || 0 : 0;
    return found.sort(
      (a, b) => time(b) - time(a) || b.version.localeCompare(a.version),
    );
  }

  return {
    async list(): Promise<Versions> {
      if (config.channel !== "dev") {
        return {
          channel: config.channel,
          versions: [{ version: config.channel }],
        };
      }
      return {
        channel: config.channel,
        versions: (await builds()).slice(0, listedBuilds),
      };
    },

    builds,
  };
}

export type VersionList = ReturnType<typeof createVersionList>;
