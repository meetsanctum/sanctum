import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pruneSnapshots, restore, snapshot } from "../src/update/backup.js";

const durable = vi.hoisted(() => ({
  onFileSystemSync: async (_path: string) => {},
  onPathSync: async (_path: string) => {},
}));

vi.mock("../src/durable.js", () => ({
  syncFileSystem: (path: string) => durable.onFileSystemSync(path),
  syncPath: (path: string) => durable.onPathSync(path),
}));

beforeEach(() => {
  durable.onFileSystemSync = async () => {};
  durable.onPathSync = async () => {};
});

describe("update backups", () => {
  it("restores a snapshot over newer data", async () => {
    const root = await mkdtemp(join(tmpdir(), "sanctum-backup-"));
    const data = join(root, "data");
    await mkdir(join(data, "apps"), { recursive: true });
    await writeFile(join(data, "core.db"), "before");
    await writeFile(join(data, "apps", "example.db"), "example");

    const saved = await snapshot(data, join(root, "backups"), "core-1");
    await writeFile(join(data, "core.db"), "after");
    await writeFile(join(data, "update-pending"), "x");
    await restore(saved, data);

    expect(await readdir(data)).toEqual(["apps", "core.db"]);
    expect(await readFile(join(data, "core.db"), "utf8")).toBe("before");
    expect(await readFile(join(data, "apps", "example.db"), "utf8")).toBe(
      "example",
    );
  });

  it("has a snapshot on the disk before it takes its name, and its name after", async () => {
    const root = await mkdtemp(join(tmpdir(), "sanctum-backup-"));
    const data = join(root, "data");
    await mkdir(data);
    await writeFile(join(data, "core.db"), "before");
    const backups = join(root, "backups");
    const seen: Array<[string, string[]]> = [];
    durable.onFileSystemSync = async (path) => {
      seen.push([path, await readdir(backups)]);
      expect(await readFile(join(path, "core.db"), "utf8")).toBe("before");
    };
    durable.onPathSync = async (path) => {
      seen.push([path, await readdir(backups)]);
    };

    await snapshot(data, backups, "core-1");

    expect(seen).toEqual([
      [join(backups, "core-1.partial"), ["core-1.partial"]],
      [backups, ["core-1"]],
    ]);
  });

  it("has restored data on the disk before it says so", async () => {
    const root = await mkdtemp(join(tmpdir(), "sanctum-backup-"));
    const data = join(root, "data");
    await mkdir(data);
    await writeFile(join(data, "core.db"), "before");
    const saved = await snapshot(data, join(root, "backups"), "core-1");
    await writeFile(join(data, "core.db"), "after");
    const synced: string[] = [];
    durable.onFileSystemSync = async (path) => {
      synced.push(await readFile(join(path, "core.db"), "utf8"));
    };

    await restore(saved, data);

    expect(synced).toEqual(["before"]);
  });

  it("keeps the newest snapshots and drops partial ones", async () => {
    const backups = await mkdtemp(join(tmpdir(), "sanctum-backups-"));
    for (const name of [
      "core-1",
      "core-2",
      "core-3",
      "core-4.partial",
      "other",
    ]) {
      await mkdir(join(backups, name));
    }

    await pruneSnapshots(backups, "core-", 2);

    expect((await readdir(backups)).sort()).toEqual([
      "core-2",
      "core-3",
      "other",
    ]);
  });
});
