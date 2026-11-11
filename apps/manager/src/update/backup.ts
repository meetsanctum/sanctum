import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { syncFileSystem, syncPath } from "../durable.js";

// Update snapshots of the core's data volume. The core is stopped while they
// are taken, so its SQLite files are consistent without SQLite's backup API.
// Copies of services' data, in the same folder, are taken through Docker
// (services/image-change.ts) and share the naming and pruning. A copy counts
// only once it's on the disk: the journal goes on to rely on it, and a power
// cut must not take it away.

const copyOptions = {
  recursive: true,
  preserveTimestamps: true,
  verbatimSymlinks: true,
} as const;

export async function snapshot(
  source: string,
  backupsDir: string,
  name: string,
) {
  const target = join(backupsDir, name);
  const partial = `${target}.partial`;
  await mkdir(backupsDir, { recursive: true });
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial);
  await cp(source, partial, copyOptions);
  await syncFileSystem(partial);
  await rename(partial, target);
  await syncPath(backupsDir);
  return target;
}

// Replaces the contents of `target` (a mounted volume, so the directory
// itself stays) with the snapshot.
export async function restore(snapshotDir: string, target: string) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(target)) {
    await rm(join(target, entry), { recursive: true, force: true });
  }
  await cp(snapshotDir, target, copyOptions);
  await syncFileSystem(target);
}

// Keeps the newest `keep` snapshots with this prefix and drops partial ones.
export async function pruneSnapshots(
  backupsDir: string,
  prefix: string,
  keep: number,
) {
  const entries = (await readdir(backupsDir).catch(() => []))
    .filter((entry) => entry.startsWith(prefix))
    .sort();
  const complete = entries.filter((entry) => !entry.endsWith(".partial"));
  const stale = [
    ...entries.filter((entry) => entry.endsWith(".partial")),
    ...complete.slice(0, Math.max(0, complete.length - keep)),
  ];
  for (const entry of stale) {
    await rm(join(backupsDir, entry), { recursive: true, force: true });
  }
}

export function snapshotName(prefix: string, version: string | undefined) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 19);
  return `${prefix}${stamp}-${version ?? "unknown"}`;
}
