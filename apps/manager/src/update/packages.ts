import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

import { z } from "zod";

import { appIdPattern } from "../apps/containers.js";
import { managerDataVolumeName } from "../core-container.js";
import { assertManaged, managedLabels, type Log } from "../docker-resources.js";
import {
  errorMessage,
  inspectContainer,
  isNotFound,
  type DockerClientLike,
} from "../docker.js";
import { syncFileSystem, syncPath } from "../durable.js";
import { stacked } from "../stack.js";
import { readJson, writeJson } from "../state.js";
import type { StackPackages } from "./stack-packages.js";

// Each official app's package, kept apart from the core's image, which an
// update replaces. Once a core image is committed, the manager copies the apps
// it ships to /data/packages/<id>/<folder>, keeping the version before for
// going back. A folder appears only once it's whole and on the disk, and never
// changes after that, so it can be mounted read-only.
//
// A folder is named for its version and what it holds, since a build can change
// an app's code and leave its version. A development stack's image ships none:
// its apps come from the worktree (stack-packages.ts), staged the same way.

// In the core's image.
const shippedAt = "/app/catalog/official";
// In the container that writes to the volume. Neither it nor the one that reads
// the image ever starts, so this asks nothing of the image, and Docker does the
// unpacking.
const volumeAt = "/sanctum-manager-data";
const digestLength = 16;

// The core validates the full manifest. Staging needs its reverse-DNS id and
// a version safe in a folder name, including SemVer's build metadata.
const shippedManifest = z.object({
  id: z.string().regex(appIdPattern),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
});

export type StagedPackage = {
  version: string;
  // Its folder under /data/packages/<id>.
  folder: string;
};

export type PackagesState = {
  // The core image these were last staged from.
  image?: string;
  apps: Record<string, { current: StagedPackage; previous?: StagedPackage }>;
};

// Names what a package holds: its paths, permissions, links and contents, not
// when it was built.
export async function digestOf(root: string) {
  const hash = createHash("sha256");
  async function visit(folder: string, prefix: string) {
    const names = (await readdir(folder)).sort();
    for (const name of names) {
      const path = join(folder, name);
      const shown = `${prefix}${name}`;
      const entry = await lstat(path);
      if (entry.isDirectory()) {
        hash.update(`folder ${shown} ${entry.mode & 0o777}\0`);
        await visit(path, `${shown}/`);
      } else if (entry.isSymbolicLink()) {
        hash.update(`link ${shown} ${await readlink(path)}\0`);
      } else if (entry.isFile()) {
        const contents = await readFile(path);
        hash.update(`file ${shown} ${entry.mode & 0o777} ${contents.length}\0`);
        hash.update(contents);
      } else {
        throw new Error(`${shown} is not a file, a folder or a link`);
      }
    }
  }
  await visit(root, "");
  return hash.digest("hex").slice(0, digestLength);
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

// The files under a folder, one with several names counted once across calls.
async function sizeOf(folder: string, seen: Set<number>) {
  let bytes = 0;
  const entries = await readdir(folder, {
    withFileTypes: true,
    recursive: true,
  });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const { ino, size } = await lstat(join(entry.parentPath, entry.name));
    if (seen.has(ino)) continue;
    seen.add(ino);
    bytes += size;
  }
  return bytes;
}

export function createPackages(options: {
  docker: DockerClientLike;
  // The manager's data volume, mounted here.
  dataDir: string;
  log: Log;
  // What runs or may have to run again, whichever versions were staged since.
  inUse?: () => Promise<readonly { app: string; folder: string }[]>;
  // A development stack's apps, for an image that ships none.
  worktree?: StackPackages;
}) {
  const { docker, dataDir, log } = options;
  const root = join(dataDir, "packages");
  const staging = join(root, ".staging");
  const statePath = join(dataDir, "packages.json");
  const helpers = [
    stacked("sanctum-packages-reader"),
    stacked("sanctum-packages-writer"),
  ] as const;
  const helperRole = "packages-copy";
  const volume = managerDataVolumeName;
  let queue: Promise<void> = Promise.resolve();
  // Images found to ship no packages, which never change what they hold.
  const shipNone = new Set<string>();
  // A development stack's apps may have been built again while its manager was
  // stopped, so one that starts stages them afresh, once.
  let hasStaged = false;

  const packagePath = (id: string, folder: string) => join(root, id, folder);

  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function readState(): Promise<PackagesState> {
    return (await readJson<PackagesState>(statePath)) ?? { apps: {} };
  }

  async function isStaged(state: PackagesState, image: string) {
    if (state.image !== image) return false;
    for (const [id, app] of Object.entries(state.apps)) {
      if (!(await exists(packagePath(id, app.current.folder)))) return false;
    }
    return true;
  }

  // A crash can leave them behind.
  async function removeHelpers() {
    for (const name of helpers) {
      const stale = await inspectContainer(docker, name);
      if (stale) {
        assertManaged({ labels: stale.Config.Labels, name }, helperRole);
        await docker.getContainer(stale.Id).remove({ force: true, v: true });
      }
    }
  }

  // Whether the image ships any: a development stack's has its apps in the
  // worktree instead. Docker keeps a container locked while its archive is
  // read, so reading the image and writing to the volume take one each.
  async function unpack(image: string) {
    await removeHelpers();
    const [reader, writer] = helpers;
    const created: string[] = [];
    let archive: Readable | undefined;
    try {
      const source = await docker.createContainer({
        name: reader,
        Image: image,
        Labels: managedLabels(helperRole),
      });
      created.push(source.id);
      const destination = await docker.createContainer({
        name: writer,
        Image: image,
        Labels: managedLabels(helperRole),
        HostConfig: { Binds: [`${volume}:${volumeAt}`] },
      });
      created.push(destination.id);
      try {
        archive = await docker
          .getContainer(source.id)
          .getArchive({ path: `${shippedAt}/.` });
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
      await docker.getContainer(destination.id).putArchive(archive, {
        path: `${volumeAt}/packages/.staging`,
      });
      return true;
    } finally {
      // A rejected write can leave the source unread and its container locked.
      archive?.destroy();
      for (const id of created) {
        await docker
          .getContainer(id)
          .remove({ force: true, v: true })
          .catch(() => undefined);
      }
    }
  }

  async function keep(from: string) {
    const parsed = shippedManifest.safeParse(
      await readJson(join(from, "sanctum-app.json")),
    );
    if (!parsed.success) {
      throw new Error(`${from} has no usable sanctum-app.json`);
    }
    const { id, version } = parsed.data;
    const folder = `${version}+${await digestOf(from)}`;
    const target = packagePath(id, folder);
    // Its name says what it holds, so one that's there is the same package.
    if (!(await exists(target))) {
      await mkdir(dirname(target), { recursive: true });
      await rename(from, target);
      await syncPath(dirname(target));
      await syncPath(root);
      log(`Staged ${id} ${folder}`);
    }
    return { id, staged: { version, folder } };
  }

  // Drops whatever the record doesn't name, such as what a crash left behind
  // before it was noted, or the version two updates ago.
  async function prune(state: PackagesState) {
    const remove = (path: string) => rm(path, { recursive: true, force: true });
    for (const id of await readdir(root)) {
      if (id === ".staging") continue;
      const app = state.apps[id];
      if (!app) {
        await remove(join(root, id));
        continue;
      }
      const inUse = (await options.inUse?.()) ?? [];
      for (const folder of await readdir(join(root, id))) {
        if (
          folder !== app.current.folder &&
          folder !== app.previous?.folder &&
          !inUse.some((each) => each.app === id && each.folder === folder)
        ) {
          await remove(join(root, id, folder));
        }
      }
    }
  }

  // What the image ships into staging, or for one that ships none, as a
  // development stack's, its apps from the worktree, or those named.
  // The worktree's builds it assembled, to note once they're staged.
  async function unpackOrAssemble(image: string, only?: readonly string[]) {
    if (!shipNone.has(image)) {
      if (await unpack(image)) return { ships: true };
      shipNone.add(image);
    }
    if (!options.worktree) return { ships: false };
    return {
      ships: true,
      assembled: await options.worktree.assemble(staging, only),
    };
  }

  // Staging an image's packages, unless it's staged, or `again`: a development
  // stack's apps once more, or those named, after their build changed.
  async function run(
    image: string,
    again?: { only?: readonly string[] | undefined },
  ) {
    const state = await readState();
    const mayKeep = !options.worktree || hasStaged;
    if (!again && mayKeep && (await isStaged(state, image))) {
      // The record may have reached the disk just before a crash, leaving
      // cleanup unfinished even though no package needs unpacking again.
      await removeHelpers();
      await rm(staging, { recursive: true, force: true });
      await prune(state);
      return;
    }

    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      // A failed attempt may have placed whole packages without noting them.
      // Free those before another archive needs space, even if it fails too.
      await prune(state);
      const { ships: shipsPackages, assembled } = await unpackOrAssemble(
        image,
        again?.only,
      );
      const next: PackagesState = { image, apps: { ...state.apps } };
      if (shipsPackages) {
        // Whole on the disk before any appears under its own name.
        await syncFileSystem(staging);
        for (const name of (await readdir(staging)).sort()) {
          const { id, staged } = await keep(join(staging, name));
          const app = next.apps[id];
          if (app?.current.folder !== staged.folder) {
            next.apps[id] = {
              current: staged,
              ...(app ? { previous: app.current } : {}),
            };
          }
        }
      }
      await writeJson(statePath, next);
      await prune(next);
      if (assembled) options.worktree?.noteStaged(assembled);
      hasStaged = true;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  // The versions kept for going back, of apps that have nothing to go back from.
  async function notNeeded(canGoBack: (app: string) => Promise<boolean>) {
    const state = await readState();
    const found: Array<{ app: string; path: string }> = [];
    for (const [app, { previous }] of Object.entries(state.apps)) {
      if (previous && !(await canGoBack(app))) {
        found.push({ app, path: packagePath(app, previous.folder) });
      }
    }
    return { state, found };
  }

  return {
    // Whether this version of the app is still staged.
    has: (id: string, folder: string) => exists(packagePath(id, folder)),

    // What Free up space could clear, a file shared between them counted once.
    clearable(canGoBack: (app: string) => Promise<boolean>) {
      return inTurn(async () => {
        const { found } = await notNeeded(canGoBack);
        let bytes = 0;
        const seen = new Set<number>();
        for (const { path } of found) {
          bytes += await sizeOf(path, seen).catch(() => 0);
        }
        return { folders: found.length, bytes };
      });
    },

    // Clears them, in turn with staging, which also keeps the record.
    clear(canGoBack: (app: string) => Promise<boolean>) {
      return inTurn(async () => {
        const { state, found } = await notNeeded(canGoBack);
        if (found.length === 0) return;
        const next: PackagesState = { ...state, apps: { ...state.apps } };
        for (const { app } of found) {
          next.apps[app] = { current: state.apps[app]!.current };
        }
        // Noted first: a crash then leaves a folder the next pass prunes, not a
        // record of a folder that's gone.
        await writeJson(statePath, next);
        await prune(next);
        log(`Cleared ${found.length} staged versions nothing can go back to`);
      });
    },

    // What's staged for this image, staging it first if it hasn't been, as when a
    // core asks before its update's commit has reached here. Nothing, if that fails.
    stagedFor(image: string) {
      return inTurn(async () => {
        const known = await readState();
        if (await isStaged(known, image)) return known.apps;
        await run(image).catch((error: unknown) => {
          log(`Could not stage the apps' packages: ${errorMessage(error)}`);
        });
        const state = await readState();
        return (await isStaged(state, image)) ? state.apps : {};
      });
    },

    // Staging one image's packages, after any other. It never fails what asked
    // for it: the next start or update tries again, and a core that asks for
    // what's staged has it staged first (stagedFor).
    stage(image: string) {
      return inTurn(() => run(image)).catch((error: unknown) => {
        log(`Could not stage the apps' packages: ${errorMessage(error)}`);
      });
    },

    // A development stack's apps again, or those named by their folder, after
    // their build changed: the ids of those now on a new package. Undefined
    // while nothing is staged to stage them beside, and on a failure, which is
    // logged.
    restage(only?: readonly string[]) {
      return inTurn(async () => {
        const before = await readState();
        if (!before.image) return undefined;
        await run(before.image, { only });
        const after = await readState();
        return Object.keys(after.apps).filter(
          (id) =>
            after.apps[id]?.current.folder !== before.apps[id]?.current.folder,
        );
      }).catch((error: unknown) => {
        log(`Could not stage the apps' packages: ${errorMessage(error)}`);
        return undefined;
      });
    },
  };
}
