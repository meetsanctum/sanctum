import type { Channel } from "../config.js";
import { assertManaged, managedLabels } from "../docker-resources.js";
import {
  errorMessage,
  imageServiceLabel,
  imageVersionLabel,
  inspectContainer,
  inspectImage,
  tagOf,
  type DockerClientLike,
  type WaitableContainerLike,
  type Labels,
} from "../docker.js";
import { mosquittoImage } from "../services/mosquitto.js";
import { zigbee2mqttImage } from "../services/zigbee2mqtt.js";
import type { UpdateJournal } from "../update/journal.js";
import {
  RegistryError,
  type Manifest,
  type Registry,
} from "../update/registry.js";
import type { AvailableVersion } from "../update/versions.js";
import { isOurs, stacked } from "../stack.js";

// Free up space, from Settings → Status: removes the versions of Sanctum and
// its services that nothing needs any more, and on a dev host the builds in
// its registry it will neither go back nor forward to. It keeps what runs,
// the version before, which a rollback needs, and on a dev host the newest
// build too. The home's data and its backups are never touched.
//
// The registry removes a build only once deleting is allowed
// (REGISTRY_STORAGE_DELETE_ENABLED in deploy/compose.yml); its layers then
// go when it collects its garbage, for which it stops for a few seconds.

export type SpaceDockerLike = Pick<
  DockerClientLike,
  "createContainer" | "getImage" | "listContainers"
> & {
  df: () => Promise<{
    Images?: Array<{
      Id: string;
      RepoTags?: string[] | null;
      RepoDigests?: string[] | null;
      Labels?: Labels | null;
      Size: number;
      SharedSize: number;
    }> | null;
  }>;
  getContainer: (id: string) => WaitableContainerLike;
};

// What Free up space would remove, and what it keeps.
export type SpacePlan = {
  // About how much it frees: images' own layers and the builds' layers
  // that no kept build shares.
  bytes: number;
  // Old versions of Sanctum's parts (core, manager) and of its services.
  images: Array<{ service: string; version: string | null }>;
  // How many dev builds go.
  devBuilds: number;
  keeps: { running: string; before: string | null; newest: string | null };
};

export class SpaceConflictError extends Error {}

const registryContainerName = stacked("sanctum-registry");
const cleanupContainerName = stacked("sanctum-registry-cleanup");
const cleanupRole = "registry-cleanup";
const devRepositories = ["sanctum-core", "sanctum-manager"];
// The services' images, by repository, and the one each runs now.
const serviceImages: Record<string, { service: string; image: string }> = {
  [repositoryOf(mosquittoImage)]: {
    service: "mosquitto",
    image: mosquittoImage,
  },
  [repositoryOf(zigbee2mqttImage)]: {
    service: "zigbee2mqtt",
    image: zigbee2mqttImage,
  },
};

// "ghcr.io/koenkk/zigbee2mqtt:2.14.2" → "ghcr.io/koenkk/zigbee2mqtt".
function repositoryOf(reference: string) {
  return reference.replace(/@.*$/, "").replace(/:[^:/]+$/, "");
}

// The digests a build's manifest stands for, an index's own manifests
// included, and the layers each refers to.
type BuildParts = {
  manifests: string[];
  blobs: Map<string, number>;
};

export function createSpace(options: {
  docker: SpaceDockerLike;
  channel: Channel;
  // The manager's own version, which the host runs.
  version: string;
  journal: { read: () => Promise<UpdateJournal | null> };
  // Present on a dev host.
  registry?: Registry;
  builds?: () => Promise<AvailableVersion[]>;
  // Whether an update is running, which needs the images it pulled.
  busy: () => Promise<boolean>;
  free: () => Promise<number | null>;
  // Counts what takes the space again, once some is freed.
  recount: () => void;
  // Staged packages nothing can go back to (update/packages.ts).
  packages?: {
    clearable: () => Promise<{ folders: number; bytes: number }>;
    clear: () => Promise<void>;
  };
  log: (message: string) => void;
}) {
  const { docker, log } = options;
  let freeing = false;

  // The last update's versions and the images it replaced, which a rollback
  // goes back to.
  async function before() {
    const journal = await options.journal.read();
    if (journal?.outcome !== "updated") {
      return { version: null, images: [] as string[] };
    }
    return {
      version: journal.core.fromVersion ?? null,
      images: [journal.core.fromImageId, journal.manager.fromImageId].filter(
        (id): id is string => id !== undefined,
      ),
    };
  }

  async function oldImages(keep: readonly string[], hasPrevious: boolean) {
    const [df, containers] = await Promise.all([
      docker.df(),
      docker.listContainers({ all: true }),
    ]);
    const used = new Set(containers.map((container) => container.ImageID));
    const current = new Set<string>();
    for (const { image } of Object.values(serviceImages)) {
      const found = await inspectImage(docker, image);
      if (found) current.add(found.Id);
    }
    const old: Array<{
      id: string;
      service: string;
      version: string | null;
      bytes: number;
    }> = [];
    for (const image of df.Images ?? []) {
      if (
        !isOurs(image.Labels) ||
        used.has(image.Id) ||
        current.has(image.Id) ||
        keep.includes(image.Id)
      )
        continue;
      const references = [
        ...(image.RepoTags ?? []),
        ...(image.RepoDigests ?? []),
      ].filter((reference) => !reference.startsWith("<none>"));
      const label = image.Labels?.[imageServiceLabel];
      // A failed or no-op update overwrites the journal's rollback refs.
      // Keep Sanctum's images until the previous version is known again.
      if (!hasPrevious && (label === "core" || label === "manager")) continue;
      const service =
        label === "core" || label === "manager"
          ? label
          : references
              .map((reference) => serviceImages[repositoryOf(reference)])
              .find((found) => found !== undefined)?.service;
      if (!service) continue;
      old.push({
        id: image.Id,
        service,
        version:
          image.Labels?.[imageVersionLabel] ??
          (image.RepoTags ?? []).map(tagOf).find((tag) => tag !== null) ??
          null,
        bytes: Math.max(0, image.Size - Math.max(0, image.SharedSize)),
      });
    }
    return old;
  }

  async function registryContainer() {
    return inspectContainer(docker, registryContainerName);
  }

  // Whether the registry may remove builds, from its container's settings.
  async function canRemoveBuilds() {
    const container = await registryContainer();
    return (container?.Config.Env ?? []).some(
      (entry) => entry.toLowerCase() === "registry_storage_delete_enabled=true",
    );
  }

  async function partsOf(repository: string, tag: string): Promise<BuildParts> {
    const registry = options.registry!;
    const parts: BuildParts = { manifests: [], blobs: new Map() };
    const add = (found: Manifest) => {
      if ("manifests" in found) return found.manifests;
      for (const blob of [found.config, ...(found.layers ?? [])]) {
        parts.blobs.set(blob.digest, blob.size ?? 0);
      }
      return [];
    };
    const { manifest, digest } = await registry.manifest(repository, tag);
    if (digest) parts.manifests.push(digest);
    for (const child of add(manifest)) {
      parts.manifests.push(child.digest);
      add((await registry.manifest(repository, child.digest)).manifest);
    }
    return parts;
  }

  async function oldBuilds(keep: ReadonlySet<string>) {
    if (!options.registry || !(await canRemoveBuilds())) {
      return { tags: 0, manifests: [] as Array<[string, string]>, bytes: 0 };
    }
    const kept = { manifests: new Set<string>(), blobs: new Set<string>() };
    const removed: Array<{
      repository: string;
      tag: string;
      parts: BuildParts;
    }> = [];
    for (const repository of devRepositories) {
      const tags = await options.registry.tags(repository);
      // A few at a time, to spare a Pi's registry.
      for (let start = 0; start < tags.length; start += 6) {
        const batch = tags.slice(start, start + 6);
        const found = await Promise.all(
          batch.map((tag) => partsOf(repository, tag)),
        );
        batch.forEach((tag, index) => {
          const parts = found[index]!;
          if (keep.has(tag)) {
            for (const each of parts.manifests) kept.manifests.add(each);
            for (const each of parts.blobs.keys()) kept.blobs.add(each);
          } else {
            removed.push({ repository, tag, parts });
          }
        });
      }
    }
    const manifests = new Map<string, [string, string]>();
    const blobs = new Map<string, number>();
    for (const { repository, parts } of removed) {
      for (const digest of parts.manifests) {
        if (!kept.manifests.has(digest)) {
          manifests.set(`${repository}@${digest}`, [repository, digest]);
        }
      }
      for (const [digest, size] of parts.blobs) {
        if (!kept.blobs.has(digest)) blobs.set(digest, size);
      }
    }
    const tags = new Set(removed.map(({ tag }) => tag)).size;
    return {
      tags,
      manifests: [...manifests.values()],
      bytes: [...blobs.values()].reduce((sum, size) => sum + size, 0),
    };
  }

  async function plan() {
    const previous = await before();
    const builds = options.builds ? await options.builds() : [];
    const keeps = {
      running: options.version,
      before: previous.version,
      newest: builds[0]?.version ?? null,
    };
    const hasPrevious = previous.version !== null;
    const images = await oldImages(previous.images, hasPrevious);
    // An incomplete update can also leave core and manager on different
    // versions. With no reliable history, neither's build may be discarded.
    const devBuilds = hasPrevious
      ? await oldBuilds(
          new Set(
            [keeps.running, keeps.before, keeps.newest].filter(
              (tag): tag is string => tag !== null,
            ),
          ),
        )
      : { tags: 0, manifests: [] as Array<[string, string]>, bytes: 0 };
    return { keeps, images, devBuilds };
  }

  // The helper is also the recovery marker. Keep it until the registry is
  // running again, so a manager crash cannot strand a stopped registry.
  async function resume() {
    if (options.channel !== "dev") return;
    const pending = await inspectContainer(docker, cleanupContainerName);
    if (!pending) return;
    assertManaged(
      { labels: pending.Config.Labels, name: pending.Name },
      cleanupRole,
    );
    const cleanup = docker.getContainer(pending.Id);
    if (pending.State.Running) await cleanup.wait();
    const registry = await registryContainer();
    if (!registry)
      throw new Error("The registry is missing during cleanup recovery");
    if (!registry.State.Running) await docker.getContainer(registry.Id).start();
    await cleanup.remove({ force: true });
  }

  // Collects the registry's garbage while it is stopped, so no push lands
  // half-collected, and starts it again whatever happens.
  async function collectGarbage() {
    await resume();
    const registry = await registryContainer();
    if (!registry) return;
    const config =
      (registry.Config.Cmd ?? []).find((arg) => /\.ya?ml$/.test(arg)) ??
      "/etc/distribution/config.yml";
    await docker.createContainer({
      name: cleanupContainerName,
      Image: registry.Image,
      Cmd: ["garbage-collect", config],
      Labels: managedLabels(cleanupRole),
      HostConfig: {
        Binds: (registry.Mounts ?? [])
          .filter((mount) => mount.Type === "volume" && mount.Name)
          .map((mount) => `${mount.Name}:${mount.Destination}`),
      },
    });
    try {
      await docker.getContainer(registry.Id).stop();
      const cleanup = docker.getContainer(cleanupContainerName);
      await cleanup.start();
      const { StatusCode } = await cleanup.wait();
      if (StatusCode !== 0) {
        throw new Error(`The registry's cleanup ended with ${StatusCode}`);
      }
    } finally {
      await resume();
    }
  }

  return {
    freeing: () => freeing,
    resume,

    async plan(): Promise<SpacePlan> {
      const { keeps, images, devBuilds } = await plan();
      const packages = (await options.packages?.clearable()) ?? { bytes: 0 };
      return {
        bytes:
          images.reduce((sum, image) => sum + image.bytes, 0) +
          devBuilds.bytes +
          packages.bytes,
        images: images.map(({ service, version }) => ({ service, version })),
        devBuilds: devBuilds.tags,
        keeps,
      };
    },

    // Removes what the plan would, and answers with what it freed, as the
    // disk counts it.
    async free() {
      if (freeing) {
        throw new SpaceConflictError("Space is already being freed");
      }
      freeing = true;
      try {
        if (await options.busy()) {
          throw new SpaceConflictError("An update is running");
        }
        const freeBefore = await options.free();
        const { images, devBuilds } = await plan();
        await options.packages?.clear();
        for (const image of images) {
          await docker
            .getImage(image.id)
            .remove({ force: true })
            .catch((error: unknown) =>
              log(`Could not remove ${image.id}: ${errorMessage(error)}`),
            );
        }
        if (devBuilds.manifests.length > 0) {
          for (const [repository, digest] of devBuilds.manifests) {
            if (!(await options.registry!.remove(repository, digest))) {
              throw new RegistryError(
                "The host's registry refused to remove old builds",
              );
            }
          }
          await collectGarbage();
        }
        log(
          `Freed up space: ${images.length} old images, ${devBuilds.tags} dev builds`,
        );
        const freeAfter = await options.free();
        return {
          freed:
            freeBefore === null || freeAfter === null
              ? null
              : Math.max(0, freeAfter - freeBefore),
        };
      } finally {
        // A registry failure can follow successful image removal. Refresh
        // storage even when only part of the cleanup completed.
        options.recount();
        freeing = false;
      }
    },
  };
}

export type Space = ReturnType<typeof createSpace>;
