import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  brokenPromises,
  isOlderVersion,
  snapshotText,
  withOldestPage,
} from "./contract.js";
import {
  defineApp,
  toStaticManifest,
  type AppDefinition,
  type StaticManifest,
} from "./index.js";

// `sanctum-app manifest [--check]`, run in an app's package after its
// build. It writes the app's static manifest, sanctum-app.json, from the
// built app, and refuses one that takes away an action, event, setting or
// widget without a new major version. One that does take something away also
// raises the oldest of its pages it works with, which only this keeps.
// --check writes nothing and fails when the committed file is missing or
// stale; with SANCTUM_CONTRACT_BASE set to a git ref, such as the branch a
// pull request goes into, it also fails when the committed file breaks that
// ref's.

export const snapshotFile = "sanctum-app.json";

type PackageEntry = string | { import?: string; default?: string };
type PackageJson = {
  exports?: PackageEntry | { ".": PackageEntry };
  main?: string;
};

// The package's main entry, as the core's loader finds it.
function entryOf(packageJson: PackageJson) {
  const root =
    typeof packageJson.exports === "object" && "." in packageJson.exports
      ? packageJson.exports["."]
      : packageJson.exports;
  const entry =
    typeof root === "string" ? root : (root?.import ?? root?.default);
  return entry ?? packageJson.main ?? "index.js";
}

/** The static manifest of the built app in `packageDir`. */
export async function buildManifest(
  packageDir: string,
): Promise<StaticManifest> {
  const packageJson = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  ) as PackageJson;
  const entry = resolve(packageDir, entryOf(packageJson));
  if (!existsSync(entry)) {
    throw new Error(`No ${entryOf(packageJson)}: build the app first`);
  }
  const loaded = (await import(pathToFileURL(entry).href)) as {
    default?: unknown;
  };
  return toStaticManifest(defineApp(loaded.default as AppDefinition));
}

// The snapshot as a git ref has it, or nothing where it has none.
function snapshotAt(ref: string, packageDir: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: packageDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    const commit = git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ).trim();
    // Only an absent file is a new contract. Missing refs and Git failures
    // must not silently disable the comparison.
    if (!git("ls-tree", "--name-only", commit, "--", snapshotFile).trim()) {
      return undefined;
    }
    return git("show", `${commit}:./${snapshotFile}`);
  } catch (cause) {
    throw new Error(`Cannot read contract base ${ref}`, { cause });
  }
}

function assertKept(earlier: string, next: StaticManifest, against: string) {
  const previous = JSON.parse(earlier) as StaticManifest;
  const broken = brokenPromises(previous, next);
  if (broken.length > 0) {
    throw new Error(
      `${next.id} ${next.version} takes away ${broken.join(", ")} from ${against} without a new major version (below 1.0, a new minor)`,
    );
  }
  const hasLowerFloor =
    previous.oldestPage &&
    (!next.oldestPage || isOlderVersion(next.oldestPage, previous.oldestPage));
  // A removal needs pages from a new compatibility line. Keep a floor generated
  // before a later version bump, but never let a regenerated file erase it.
  const hasUncoveredChanges =
    brokenPromises(previous, {
      ...next,
      version: next.oldestPage ?? previous.version,
    }).length > 0;
  if (hasLowerFloor || hasUncoveredChanges) {
    throw new Error(
      `${snapshotFile} for ${next.id} has an oldestPage that doesn't cover ${against}: restore its page floor and run \`pnpm manifest\``,
    );
  }
}

// One a check can't read is simply stale, which it says.
function parsed(snapshot: string | undefined) {
  try {
    return snapshot === undefined
      ? undefined
      : (JSON.parse(snapshot) as StaticManifest);
  } catch {
    return undefined;
  }
}

/**
 * What to do with a freshly built manifest, given the committed snapshot
 * and, for a check, the one a base ref has: the text to write, if any, and
 * what was done. Throws when the snapshot is missing or stale, or the
 * manifest breaks the contract.
 */
export function decide(
  manifest: StaticManifest,
  committed: string | undefined,
  options: { check: boolean; base?: { ref: string; text: string } },
): { write?: string; message: string } {
  const next = withOldestPage(manifest, parsed(committed));
  const text = snapshotText(next);
  if (!options.check) {
    if (committed !== undefined) {
      assertKept(committed, next, `its ${snapshotFile}`);
    }
    return { write: text, message: `wrote ${snapshotFile} for ${manifest.id}` };
  }
  if (committed !== text) {
    throw new Error(
      `${snapshotFile} for ${manifest.id} is ${committed === undefined ? "missing" : "out of date"}: run \`pnpm manifest\` and commit it`,
    );
  }
  if (options.base) assertKept(options.base.text, next, options.base.ref);
  return { message: `${snapshotFile} for ${manifest.id} is current` };
}

/** Writes or checks the snapshot in `packageDir`; resolves to what it did. */
export async function manifestCommand(
  packageDir: string,
  options: { check: boolean; base?: string },
) {
  const manifest = await buildManifest(packageDir);
  const file = join(packageDir, snapshotFile);
  const committed = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const baseText =
    options.check && options.base
      ? snapshotAt(options.base, packageDir)
      : undefined;
  const { write, message } = decide(manifest, committed, {
    check: options.check,
    ...(options.base && baseText !== undefined
      ? { base: { ref: options.base, text: baseText } }
      : {}),
  });
  if (write !== undefined) {
    // Whole or not at all: a run cut short leaves the old snapshot.
    const partial = `${file}.${process.pid}.tmp`;
    writeFileSync(partial, write);
    renameSync(partial, file);
  }
  return message;
}

export async function main(argv: readonly string[]) {
  const [command, ...flags] = argv;
  if (command !== "manifest" || flags.some((flag) => flag !== "--check")) {
    throw new Error("Usage: sanctum-app manifest [--check]");
  }
  return manifestCommand(process.cwd(), {
    check: flags.includes("--check"),
    base: process.env.SANCTUM_CONTRACT_BASE || undefined,
  });
}
