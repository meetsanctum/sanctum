import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContainerCreateOptions, Labels } from "../src/docker.js";
import { createDiskReader, diskWritesOf } from "../src/host/writeback-disk.js";
import {
  backlogOf,
  createWriteback,
  createWritebackHelper,
  memoryOf,
  limitsFor,
  pageSizeOf,
  type WritebackLimits,
} from "../src/host/writeback.js";
import { notFound } from "./fake-docker.js";

const mb = 1024 * 1024;
const gb = 1024 * mb;
const page = 4096;
const floor = { backgroundBytes: 8 * mb, bytes: 32 * mb };

afterEach(() => {
  vi.useRealTimers();
});

describe("limitsFor", () => {
  it("uses the startup limits until it measures the disk", () => {
    expect(limitsFor(null, 8 * gb)).toEqual(floor);
  });

  it("holds the floor for an SD card, whose two seconds are less", () => {
    expect(limitsFor(7 * mb, 8 * gb)).toEqual(floor);
  });

  it("gives a fast disk half a second and two seconds of its writing", () => {
    expect(limitsFor(3 * gb, 128 * gb)).toEqual({
      backgroundBytes: 1.5 * gb,
      bytes: 6 * gb,
    });
  });

  it("caps both limits in whole pages below the kernel's share", () => {
    expect(limitsFor(3 * gb, gb)).toEqual({
      backgroundBytes: Math.floor((0.1 * gb) / page) * page,
      bytes: Math.floor((0.2 * gb) / page) * page,
    });
    expect(limitsFor(null, 100 * mb)).toEqual({
      backgroundBytes: 8 * mb,
      bytes: 20 * mb,
    });
  });
});

describe("the kernel's files", () => {
  it("reads the backlog and the memory available", () => {
    expect(backlogOf("Dirty: 819200 kB\nWriteback: 20480 kB\n")).toBe(
      (819200 + 20480) * 1024,
    );
    expect(backlogOf("MemTotal: 1 kB")).toBeNull();
    expect(memoryOf("MemTotal: 8 kB\nMemAvailable:    5913204 kB\n")).toBe(
      5913204 * 1024,
    );
    expect(memoryOf("MemTotal: 8 kB\n")).toBeNull();
  });

  it("reads the page size and the disk's write counters", () => {
    expect(pageSizeOf("Size: 4 kB\nKernelPageSize:       16 kB\n")).toBe(
      16 * 1024,
    );
    expect(pageSizeOf("")).toBe(page);
    expect(
      diskWritesOf("test-disk", "0 0 0 0 3 0 1152 4990 0 4980 4950"),
    ).toEqual({
      disk: "test-disk",
      bytes: 1152 * 512,
      writeMs: 4990,
      busyMs: 4980,
    });
    expect(diskWritesOf("test-disk", "0 0 0")).toBeNull();
  });
});

it("measures the disk under Sanctum's data, whatever else the host has", async () => {
  // The temporary folder's own path, links resolved, as realpath gives it.
  const root = await realpath(await mkdtemp(join(tmpdir(), "sanctum-disks-")));
  const path = (name: string) => join(root, name);
  try {
    const disk = path("sys/devices/platform/mmc0/block/mmcblk0");
    const partition = join(disk, "mmcblk0p2");
    const nvme = path("sys/devices/pci0/nvme/block/nvme0n1");
    const loop = path("sys/devices/virtual/block/loop3");
    await Promise.all(
      [partition, nvme, loop, path("sys/dev/block")].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    await Promise.all([
      symlink(partition, path("sys/dev/block/179:2")),
      symlink(nvme, path("sys/dev/block/259:0")),
      symlink(loop, path("sys/dev/block/7:3")),
      writeFile(join(partition, "partition"), "2\n"),
      writeFile(join(disk, "stat"), "0 0 0 0 3 0 1152 4990 0 4980 4950\n"),
      writeFile(join(nvme, "stat"), "0 0 0 0 3 0 2048 10 0 10 10\n"),
    ]);
    const devices = new Map([
      ["/data", "179:2"],
      ["/core-data", "179:2"],
    ]);
    const read = createDiskReader(["/data", "/core-data"], {
      root,
      deviceOf: async (dir) => devices.get(dir)!,
    });
    expect(await read()).toEqual({
      disk,
      bytes: 1152 * 512,
      writeMs: 4990,
      busyMs: 4980,
    });
    // On two disks, neither says how long the other's backlog takes.
    devices.set("/core-data", "259:0");
    expect(await read()).toBeNull();
    // A device of the kernel's own, such as a loop, LVM or encryption, has
    // no counters of the disk's.
    devices.set("/data", "7:3");
    devices.set("/core-data", "7:3");
    expect(await read()).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function host(
  options: {
    background?: number;
    limit?: number;
    pageSize?: number;
    apply?: (limits: WritebackLimits) => Promise<void>;
  } = {},
) {
  const pageSize = options.pageSize ?? page;
  const files = new Map<string, string>([
    ["proc/self/smaps", `KernelPageSize: ${pageSize / 1024} kB\n`],
    ["proc/sys/vm/dirty_background_bytes", String(options.background ?? 0)],
    ["proc/sys/vm/dirty_bytes", String(options.limit ?? 0)],
  ]);
  let disk: string | null = "test-disk";
  let pagesWritten = 0;
  let bytes = 0;
  let writeMs = 0;
  let busyMs = 0;
  const set = ({
    backlog = 0,
    written = 0,
    diskBytes = written,
    busy = 5_000,
    writing = busy,
    memory = 128 * gb,
  }: {
    backlog?: number;
    written?: number;
    diskBytes?: number;
    busy?: number;
    writing?: number;
    memory?: number;
  } = {}) => {
    pagesWritten += written / pageSize;
    bytes += diskBytes;
    writeMs += writing;
    busyMs += busy;
    files.set(
      "proc/meminfo",
      `MemAvailable: ${memory / 1024} kB\nDirty: ${backlog / 1024} kB\nWriteback: 0 kB\n`,
    );
    files.set(
      "proc/vmstat",
      `nr_written ${pagesWritten}\nnr_dirty_background_threshold ${(16 * mb) / pageSize}\n`,
    );
  };
  set();
  const applied: WritebackLimits[] = [];
  const logs: string[] = [];
  const writeback = createWriteback({
    apply: async (limits) => {
      applied.push(limits);
      await options.apply?.(limits);
    },
    log: (message) => logs.push(message),
    read: async (path) => files.get(path) ?? null,
    readDisk: async () =>
      disk === null ? null : { disk, bytes, writeMs, busyMs },
  });
  const advance = async (values: Parameters<typeof set>[0], count = 1) => {
    for (let i = 0; i < count; i++) {
      set(values);
      await vi.advanceTimersByTimeAsync(5_000);
    }
  };
  return {
    writeback,
    applied,
    logs,
    set,
    advance,
    disk: (name: string | null) => {
      disk = name;
    },
  };
}

describe("createWriteback", () => {
  it("sets the floor where the kernel holds a share of memory", async () => {
    const { writeback, applied } = host();
    await writeback.start();
    writeback.stop();
    expect(applied).toEqual([floor]);
  });

  it("keeps byte limits after a restart while writing stays below the threshold", async () => {
    vi.useFakeTimers();
    const { writeback, applied, advance } = host({
      background: 1.5 * gb,
      limit: 6 * gb,
    });
    await writeback.start();
    await advance({ backlog: 10 * mb, written: 10 * mb }, 30);
    writeback.stop();
    expect(applied).toEqual([]);
  });

  it("uses the current ratio threshold when the background byte setting is zero", async () => {
    vi.useFakeTimers();
    const { writeback, applied, advance } = host({ limit: 64 * mb });
    await writeback.start();
    await advance({ backlog: 12 * mb, written: 10 * gb }, 12);
    writeback.stop();
    expect(writeback.rate()).toBeNull();
    expect(applied).toEqual([]);
  });

  it("measures a busy fast disk on a host with 16 KiB pages", async () => {
    vi.useFakeTimers();
    const { writeback, applied, advance } = host({ pageSize: 16 * 1024 });
    await writeback.start();
    await advance({ backlog: 20 * mb, written: 10 * gb }, 12);
    writeback.stop();
    expect(writeback.rate()).toBe(2 * gb);
    expect(applied).toEqual([floor, { backgroundBytes: gb, bytes: 4 * gb }]);
  });

  it("leaves an SD card at the floor despite other completed writes", async () => {
    vi.useFakeTimers();
    const { writeback, applied, advance } = host();
    await writeback.start();
    await advance(
      { backlog: 30 * mb, written: 10 * gb, diskBytes: 35 * mb },
      12,
    );
    writeback.stop();
    expect(writeback.rate()).toBe(7 * mb);
    expect(applied).toEqual([floor]);
  });

  it.each([null, "different-disk"])(
    "returns to conservative limits when the backing disk changes to %s",
    async (device) => {
      vi.useFakeTimers();
      const { writeback, applied, advance, disk } = host();
      await writeback.start();
      await advance({ backlog: 20 * mb, written: 10 * gb }, 12);
      disk(device);
      await advance({ backlog: 20 * mb, written: 10 * gb });
      writeback.stop();
      expect(writeback.rate()).toBeNull();
      expect(applied).toEqual([
        floor,
        { backgroundBytes: gb, bytes: 4 * gb },
        floor,
      ]);
    },
  );

  it("smooths changes in the measured write rate", async () => {
    vi.useFakeTimers();
    const { writeback, advance } = host();
    await writeback.start();
    await advance({ backlog: 20 * mb, written: 50 * mb }, 2);
    expect(writeback.rate()).toBe(10 * mb);
    await advance({ backlog: 20 * mb, written: 550 * mb });
    writeback.stop();
    expect(writeback.rate()).toBe(40 * mb);
  });

  it("ignores bursts separated by disk idle time even with backlog at both ends", async () => {
    vi.useFakeTimers();
    const { writeback, applied, advance } = host();
    await writeback.start();
    await advance(
      { backlog: 20 * mb, written: 500 * mb, busy: 250, writing: 5_000 },
      12,
    );
    writeback.stop();
    expect(writeback.rate()).toBeNull();
    expect(applied).toEqual([floor]);
  });

  it("lowers the limits as soon as memory pressure takes them above the ceiling", async () => {
    vi.useFakeTimers();
    const { writeback, applied, advance } = host();
    await writeback.start();
    await advance({ backlog: 20 * mb, written: 10 * gb }, 12);
    await advance({ memory: gb });
    writeback.stop();
    expect(applied).toEqual([
      floor,
      { backgroundBytes: gb, bytes: 4 * gb },
      limitsFor(2 * gb, gb),
    ]);
  });

  it("retries at one-minute intervals across a backward clock correction", async () => {
    vi.useFakeTimers();
    const start = performance.now();
    const attempts: number[] = [];
    const { writeback, logs } = host({
      apply: async () => {
        attempts.push(performance.now() - start);
        if (attempts.length <= 2) throw new Error("Docker is busy");
      },
    });
    await writeback.start();
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(125_000);
    writeback.stop();
    expect(attempts).toEqual([0, 60_000, 120_000]);
    expect(logs.filter((line) => line.includes("Docker is busy"))).toHaveLength(
      1,
    );
    expect(writeback.applied()).toEqual(floor);
  });

  it("bounds the startup wait and keeps later applies behind a pending attempt", async () => {
    vi.useFakeTimers();
    let failAttempt!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      failAttempt = reject;
    });
    const { writeback, applied, logs } = host({
      apply: () => (applied.length === 1 ? pending : Promise.resolve()),
    });
    const completed = vi.fn();
    const started = writeback.start().then(completed);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await started;
    expect(logs).toContain(
      "Timed out waiting for the writeback limits at startup",
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(applied).toEqual([floor]);
    failAttempt(new Error("Docker is busy"));
    await vi.advanceTimersByTimeAsync(5_000);
    writeback.stop();
    expect(applied).toEqual([floor, floor]);
  });

  it("does nothing without /proc/meminfo", async () => {
    const logs: string[] = [];
    const apply = vi.fn();
    const writeback = createWriteback({
      apply,
      readDisk: async () => null,
      log: (message) => logs.push(message),
      read: async () => null,
    });
    await writeback.start();
    writeback.stop();
    expect(apply).not.toHaveBeenCalled();
    expect(logs).toEqual([
      "Not limiting what waits to be written: no /proc/meminfo",
    ]);
  });
});

type HelperDocker = Parameters<typeof createWritebackHelper>[0]["docker"];

describe("createWritebackHelper", () => {
  const owned = { "sanctum.managed": "true", "sanctum.role": "writeback" };

  function docker(
    options: { stale?: Labels; exitCode?: number; removeError?: Error } = {},
  ) {
    const created: ContainerCreateOptions[] = [];
    const events: string[] = [];
    const containers = new Map<string, { Image: string; Labels: Labels }>([
      ["sanctum-manager", { Image: "sha256:manager", Labels: {} }],
    ]);
    if (options.stale) {
      containers.set("sanctum-writeback", {
        Image: "sha256:old",
        Labels: options.stale,
      });
    }
    const fake = {
      created,
      events,
      createContainer: async (create: ContainerCreateOptions) => {
        created.push(create);
        containers.set(create.name, {
          Image: create.Image,
          Labels: create.Labels ?? {},
        });
        return { id: create.name };
      },
      getContainer: (name: string) => ({
        inspect: async () => {
          const found = containers.get(name);
          if (!found) throw notFound();
          return {
            Id: name,
            Name: `/${name}`,
            Image: found.Image,
            State: { Running: false },
            Config: { Image: found.Image, Labels: found.Labels },
            HostConfig: {},
          };
        },
        start: async () => {
          events.push(`start ${name}`);
        },
        remove: async () => {
          events.push(`remove ${name}`);
          if (options.removeError) throw options.removeError;
          containers.delete(name);
        },
        wait: async () => {
          events.push(`wait ${name}`);
          return { StatusCode: options.exitCode ?? 0 };
        },
      }),
    };
    return fake as unknown as Pick<typeof fake, "created" | "events"> &
      HelperDocker;
  }

  it("only mounts the two writable settings and runs without privileges or network", async () => {
    const fake = docker({ stale: owned });
    await createWritebackHelper({ docker: fake, log: vi.fn() })(floor);
    expect(fake.created).toHaveLength(1);
    const [create] = fake.created;
    expect(create).toMatchObject({
      name: "sanctum-writeback",
      Image: "sha256:manager",
      Entrypoint: ["sh", "-c"],
      Cmd: [
        'echo "$1" > /dirty-background-bytes && echo "$2" > /dirty-bytes',
        "writeback",
        "8388608",
        "33554432",
      ],
      Labels: owned,
    });
    expect(create!.HostConfig).toEqual({
      NetworkMode: "none",
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      Binds: [
        "/proc/sys/vm/dirty_background_bytes:/dirty-background-bytes:rw",
        "/proc/sys/vm/dirty_bytes:/dirty-bytes:rw",
      ],
    });
    expect(fake.events).toEqual([
      "remove sanctum-writeback",
      "start sanctum-writeback",
      "wait sanctum-writeback",
      "remove sanctum-writeback",
    ]);
  });

  it("preserves a same-name container with a different role", async () => {
    const fake = docker({ stale: { ...owned, "sanctum.role": "other" } });
    await expect(
      createWritebackHelper({ docker: fake, log: vi.fn() })(floor),
    ).rejects.toThrow();
    expect(fake.events).toEqual([]);
    expect(fake.created).toEqual([]);
  });

  it("reports failed cleanup without hiding the helper's failure", async () => {
    const fake = docker({
      exitCode: 1,
      removeError: new Error("Docker is busy"),
    });
    const log = vi.fn();
    await expect(
      createWritebackHelper({ docker: fake, log })(floor),
    ).rejects.toThrow("its helper ended with 1");
    expect(log).toHaveBeenCalledWith(
      "Could not remove the writeback helper: Docker is busy",
    );
    expect(fake.events.at(-1)).toBe("remove sanctum-writeback");
  });

  it("ignores cleanup if Docker already removed the helper", async () => {
    const fake = docker({ removeError: notFound() });
    const log = vi.fn();
    await createWritebackHelper({ docker: fake, log })(floor);
    expect(log).not.toHaveBeenCalled();
  });
});
