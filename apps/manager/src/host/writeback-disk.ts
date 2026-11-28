import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export type DiskWrites = {
  disk: string;
  bytes: number;
  writeMs: number;
  busyMs: number;
};

// "major:minor" of the filesystem a folder is on, as /sys/dev/block names it.
async function deviceNumberOf(path: string) {
  const dev = (await stat(path, { bigint: true })).dev;
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  return `${major}:${minor}`;
}

// The disk Sanctum's data is written to, found from the folders themselves:
// the manager's and the core's data, which sit with Docker's own. A host may
// have other disks, and every app's data image is a loop device of its own;
// only this disk's speed says how long its backlog takes. Where the folders
// are on different disks, or on one with no disk of its own under it (LVM,
// encryption, RAID), it's null, and the limits stay at their floor.
export function createDiskReader(
  dataDirs: string[],
  options: {
    root?: string;
    deviceOf?: (path: string) => Promise<string>;
  } = {},
) {
  const sys = join(options.root ?? "/", "sys");
  const deviceOf = options.deviceOf ?? deviceNumberOf;
  const diskOf = async (dir: string) => {
    const device = await realpath(join(sys, "dev/block", await deviceOf(dir)));
    const isPartition = await access(join(device, "partition")).then(
      () => true,
      () => false,
    );
    return isPartition ? dirname(device) : device;
  };
  return async (): Promise<DiskWrites | null> => {
    try {
      const disks = new Set(await Promise.all(dataDirs.map(diskOf)));
      const [disk] = disks;
      if (disks.size !== 1 || disk === undefined) return null;
      if (disk.startsWith(`${join(sys, "devices/virtual")}/`)) return null;
      return diskWritesOf(disk, await readFile(join(disk, "stat"), "utf8"));
    } catch {
      return null;
    }
  };
}

// Linux counts sectors in 512-byte units, regardless of the device's sector size.
export function diskWritesOf(disk: string, stat: string): DiskWrites | null {
  const fields = stat.trim().split(/\s+/).map(Number);
  const [sectors, writeMs, busyMs] = [fields[6], fields[7], fields[9]];
  if (sectors === undefined || writeMs === undefined || busyMs === undefined)
    return null;
  if (
    ![sectors, writeMs, busyMs].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    return null;
  return { disk, bytes: sectors * 512, writeMs, busyMs };
}
