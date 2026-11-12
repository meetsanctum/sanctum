import { access, cp, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { readJson } from "../state.js";

// A development stack's apps (deploy/dev/stack.sh). Its image holds each app's
// production dependencies, built on Linux, with none of its code
// (deploy/dev/stack.Dockerfile), and the worktree holds that code as last
// built, mounted into the manager. Put together, each is a package as a host's
// core image ships one, so the manager stages it the same way, and a new build
// is a new package, which the app updates to as it would on a host.

type Log = (message: string) => void;

// Where each app's package was built in the image, one folder each.
const dependenciesAt = "/app/stack-packages";
// The worktree, at the same paths below this.
const sourcesAt = "/app/stack-sources";
// Where the worktree keeps an app, by the folder its package is in.
const appFolders = ["catalog/apps", "deploy/dev/apps"];
// The app SDK's build, which each package holds a copy of.
const sdk = {
  from: "packages/app-sdk/dist",
  to: "node_modules/@meetsanctum/app-sdk/dist",
};

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

// Every file under a path, or the path itself, by its size and when it changed.
async function filesUnder(path: string): Promise<string[]> {
  const entry = await stat(path).catch(() => undefined);
  if (!entry) return [];
  if (!entry.isDirectory()) return [`${path} ${entry.size} ${entry.mtimeMs}`];
  const lines: string[] = [];
  for (const name of (await readdir(path)).sort()) {
    lines.push(...(await filesUnder(join(path, name))));
  }
  return lines;
}

export type StackPackages = ReturnType<typeof createStackPackages>;

export function createStackPackages(
  options: { dependencies?: string; sources?: string; log?: Log } = {},
) {
  const dependencies = options.dependencies ?? dependenciesAt;
  const sources = options.sources ?? sourcesAt;
  const log = options.log ?? (() => undefined);
  // The build each app was last staged from, as `builds` tells them.
  const staged = new Map<string, string>();

  // Each app the image built, by its folder's name, with where its code is.
  async function apps() {
    const found: { name: string; source: string }[] = [];
    const names = await readdir(dependencies).catch(() => []);
    for (const name of names.sort()) {
      for (const folder of appFolders) {
        const source = join(sources, folder, name);
        if (await exists(source)) {
          found.push({ name, source });
          break;
        }
      }
    }
    return found;
  }

  // What its package ships of its own, as its `files` list it.
  async function filesOf(source: string) {
    const manifest = await readJson<{ files?: string[] }>(
      join(source, "package.json"),
    );
    return ["package.json", ...(manifest?.files ?? [])];
  }

  // What says it changed: the app's own files and the SDK's.
  async function fingerprint(source: string) {
    const lines = await filesUnder(join(sources, sdk.from));
    for (const file of await filesOf(source)) {
      lines.push(...(await filesUnder(join(source, file))));
    }
    return lines.join("\n");
  }

  return {
    // Whether this stack's image built its apps' dependencies.
    has: () => exists(dependencies),

    // Each app's package, or those named, in a folder of its own under `into`,
    // as an image ships them, and the build each came from, to note once they're
    // staged. One not built yet is left out.
    async assemble(into: string, only?: readonly string[]) {
      const assembled = new Map<string, string>();
      for (const { name, source } of await apps()) {
        if (only && !only.includes(name)) continue;
        if (!(await exists(join(source, "sanctum-app.json")))) {
          log(`${name} isn't built yet, so it isn't staged`);
          continue;
        }
        // Before copying: a build that changes meanwhile is staged again.
        assembled.set(name, await fingerprint(source));
        const target = join(into, name);
        await cp(join(dependencies, name), target, {
          recursive: true,
          verbatimSymlinks: true,
        });
        for (const file of await filesOf(source)) {
          if (await exists(join(source, file))) {
            await cp(join(source, file), join(target, file), {
              recursive: true,
            });
          }
        }
        await cp(join(sources, sdk.from), join(target, sdk.to), {
          recursive: true,
        });
      }
      return assembled;
    },

    // That these builds are staged.
    noteStaged(builds: ReadonlyMap<string, string>) {
      for (const [name, build] of builds) staged.set(name, build);
    },

    // The build each app was last staged from, empty until the first staging.
    staged: (): ReadonlyMap<string, string> => staged,

    // What each app's build is now, by its folder's name, to notice a new one.
    async builds() {
      const found = new Map<string, string>();
      for (const { name, source } of await apps()) {
        found.set(name, await fingerprint(source));
      }
      return found;
    },
  };
}

// Calls `built` with the apps whose build differs from the one staged and has
// stayed the same for a whole look, so one still being written isn't taken.
// Nothing is offered before a first staging, which stages every app, and a
// build is offered once, so one that fails to stage waits for the next. Each
// look starts once the one before has ended.
export function watchStackBuilds(options: {
  builds: () => Promise<Map<string, string>>;
  staged: () => ReadonlyMap<string, string>;
  built: (names: string[]) => Promise<void>;
  everyMs?: number;
  log?: Log;
}) {
  const everyMs = options.everyMs ?? 1_000;
  const offered = new Map<string, string>();
  let seen = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let isClosed = false;

  async function look() {
    const now = await options.builds();
    if (isClosed) return;
    const staged = options.staged();
    const settled =
      staged.size === 0
        ? []
        : [...now]
            .filter(
              ([name, build]) =>
                staged.get(name) !== build &&
                offered.get(name) !== build &&
                seen.get(name) === build,
            )
            .map(([name]) => name);
    seen = now;
    if (settled.length === 0) return;
    for (const name of settled) offered.set(name, now.get(name)!);
    await options.built(settled);
  }

  function next() {
    if (isClosed) return;
    timer = setTimeout(() => {
      look()
        .catch((error: unknown) =>
          options.log?.(`Could not look at the apps' builds: ${String(error)}`),
        )
        .finally(next);
    }, everyMs);
  }

  next();
  return {
    close() {
      isClosed = true;
      clearTimeout(timer);
    },
  };
}

// Stages each new build of a development stack's apps and then restarts the
// core, which updates them to it as it would on a host. It waits while an update
// or another operation is under way, so it doesn't cut one short.
export function followStackBuilds(options: {
  stackPackages: StackPackages;
  restage: (names: string[]) => Promise<void>;
  isBusy: () => Promise<boolean>;
  restartCore: () => Promise<void>;
  log: Log;
  everyMs?: number;
}) {
  const everyMs = options.everyMs ?? 1_000;
  let isClosed = false;
  const pending = new Set<string>();
  let restarting: Promise<void> | undefined;

  // Staging can finish at startup or after a watched build. Keep its restart
  // pending until operations have ended, coalescing builds that arrive meanwhile.
  function staged(apps: string[]) {
    if (isClosed) return;
    for (const app of apps) pending.add(app);
    if (!pending.size) return;
    restarting ??= restart().finally(() => {
      restarting = undefined;
      if (pending.size) staged([]);
    });
  }

  async function restart() {
    while (!isClosed && pending.size) {
      let changed: string[] = [];
      try {
        if (await options.isBusy()) {
          await new Promise((done) => setTimeout(done, everyMs));
          continue;
        }
        if (isClosed) return;
        changed = [...pending];
        pending.clear();
        options.log(
          `Restarting the core for the new build of ${changed.join(", ")}`,
        );
        await options.restartCore();
      } catch (error) {
        for (const app of changed) pending.add(app);
        options.log(`Could not restart the core: ${String(error)}`);
        await new Promise((done) => setTimeout(done, everyMs));
      }
    }
  }

  const watching = watchStackBuilds({
    builds: options.stackPackages.builds,
    staged: options.stackPackages.staged,
    everyMs,
    log: options.log,
    built: async (names) => {
      await options.restage(names);
    },
  });
  return {
    staged,
    close() {
      isClosed = true;
      watching.close();
    },
  };
}
