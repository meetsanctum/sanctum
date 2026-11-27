import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

export type DiskWrites = {
  disk: string;
  bytes: number;
  writeMs: number;
  busyMs: number;
};

// Global writeback settings can only be raised when Docker and both data
// directories use a single, directly mounted disk. With multiple disks or
// a storage layout we can't identify, keep the startup limits.
export function createDiskReader(dataDirs: string[], root = "/") {
  const sys = join(root, "sys");
  return async (): Promise<DiskWrites | null> => {
    try {
      const [mountinfo, disks] = await Promise.all([
        readFile(join(root, "proc/self/mountinfo"), "utf8"),
        readdir(join(sys, "block")),
      ]);
      const mounts = mountinfo.split("\n").map((line) => line.split(" "));
      const mountAt = (path: string) => {
        const escaped = path.replace(
          /[ \t\n\\]/g,
          (char) => `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`,
        );
        return mounts.find((fields) => fields[4] === escaped);
      };
      // Overlay needs a local writable upper filesystem. Check the data
      // mounts separately, since volumes can sit on a different filesystem.
      const filesystem = (fields: string[] | undefined) =>
        fields?.[fields.indexOf("-") + 1];
      if (filesystem(mountAt("/")) !== "overlay") return null;

      const candidates = await Promise.all(
        disks
          .filter((disk) => !/^(?:ram|zram)\d+$/.test(disk))
          .map(async (disk) => {
            const path = join(sys, "block", disk);
            const size = await readFile(`${path}/size`, "utf8");
            return Number(size) > 0 ? disk : null;
          }),
      );
      const present = candidates.filter((disk) => disk !== null);
      if (present.length !== 1) return null;
      const disk = present[0]!;
      const path = join(sys, "block", disk);
      const device = await realpath(path);
      if (device.startsWith(`${join(sys, "devices/virtual")}/`)) return null;

      for (const dir of dataDirs) {
        const mount = mountAt(dir);
        const type = filesystem(mount);
        const id = mount?.[2];
        if (!id || (type !== "ext4" && type !== "xfs")) return null;
        const backing = await realpath(join(sys, "dev/block", id));
        if (backing !== device && !backing.startsWith(`${device}/`))
          return null;
      }
      return diskWritesOf(device, await readFile(`${path}/stat`, "utf8"));
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
