import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContainerCreateOptions } from "../src/docker.js";
import {
  backlogOf,
  createRateEstimate,
  createWriteback,
  createWritebackHelper,
  limitsFor,
  memoryOf,
  pageSizeOf,
  pagesWrittenOf,
  type WritebackLimits,
} from "../src/host/writeback.js";
import { notFound } from "./fake-docker.js";

// What the kernel may hold back from the disks, as time at the speed they
// were seen writing out: a save then waits seconds, never minutes, on a slow
// SD card and on a fast NVMe drive alike.

const mb = 1024 * 1024;
const gb = 1024 * mb;

afterEach(() => {
  vi.useRealTimers();
});

describe("limitsFor", () => {
  it("holds the floor for disks not seen writing yet", () => {
    expect(limitsFor(null, 8 * gb)).toEqual({
      backgroundBytes: 8 * mb,
      bytes: 32 * mb,
    });
  });

  it("holds the floor for an SD card, whose two seconds are less", () => {
    expect(limitsFor(7 * mb, 8 * gb)).toEqual({
      backgroundBytes: 8 * mb,
      bytes: 32 * mb,
    });
  });

  it("gives a fast disk half a second and two seconds of its writing", () => {
    expect(limitsFor(3 * gb, 128 * gb)).toEqual({
      backgroundBytes: 1.5 * gb,
      bytes: 6 * gb,
    });
  });

  it("never holds more than the kernel's own share of memory", () => {
    expect(limitsFor(3 * gb, 8 * gb)).toEqual({
      backgroundBytes: Math.floor(0.8 * gb),
      bytes: Math.floor(1.6 * gb),
    });
    // Nor its floor, on a machine with very little memory.
    expect(limitsFor(null, 100 * mb)).toEqual({
      backgroundBytes: 8 * mb,
      bytes: 20 * mb,
    });
  });
});

describe("the kernel's files", () => {
  const meminfo = [
    "MemTotal:        8006648 kB",
    "MemAvailable:    5913204 kB",
    "Dirty:            819200 kB",
    "Writeback:         20480 kB",
  ].join("\n");

  it("reads what waits to be written and the memory", () => {
    expect(backlogOf(meminfo)).toBe((819200 + 20480) * 1024);
    expect(memoryOf(meminfo)).toBe(8006648 * 1024);
    expect(backlogOf("MemTotal: 1 kB")).toBeNull();
  });

  it("reads the pages written out and the page size", () => {
    expect(pagesWrittenOf("nr_dirtied 10\nnr_written 7432053\n")).toBe(7432053);
    expect(pagesWrittenOf("nr_dirtied 10\n")).toBeNull();
    expect(pageSizeOf("Size: 4 kB\nKernelPageSize:       16 kB\n")).toBe(
      16 * 1024,
    );
    expect(pageSizeOf("")).toBe(4096);
  });
});

describe("the speed the disks write out at", () => {
  it("counts only intervals with data held back throughout", () => {
    const estimate = createRateEstimate();
    const page = 4096;
    estimate.add({ at: 0, written: 0, backlog: 100 * mb }, page, 8 * mb);
    // Little held back at the end: the disk may have waited for work.
    estimate.add({ at: 5_000, written: 1_000, backlog: 1 * mb }, page, 8 * mb);
    expect(estimate.rate()).toBeNull();
    estimate.add(
      { at: 10_000, written: 2_000, backlog: 50 * mb },
      page,
      8 * mb,
    );
    expect(estimate.rate()).toBeNull();
    // 8,960 pages in five seconds: 7 MiB a second.
    estimate.add(
      { at: 15_000, written: 2_000 + 8_960, backlog: 40 * mb },
      page,
      8 * mb,
    );
    expect(estimate.rate()).toBe(7 * mb);
  });

  it("moves only part of the way for one odd sample", () => {
    const estimate = createRateEstimate();
    const page = 4096;
    const second = (rate: number) => (rate * 5) / page;
    estimate.add({ at: 0, written: 0, backlog: gb }, page, mb);
    estimate.add(
      { at: 5_000, written: second(10 * mb), backlog: gb },
      page,
      mb,
    );
    estimate.add(
      { at: 10_000, written: second(10 * mb) + second(110 * mb), backlog: gb },
      page,
      mb,
    );
    expect(estimate.rate()).toBeCloseTo(40 * mb);
  });

  it("ignores a counter that went back", () => {
    const estimate = createRateEstimate();
    estimate.add({ at: 0, written: 10_000, backlog: gb }, 4096, mb);
    estimate.add({ at: 5_000, written: 5_000, backlog: gb }, 4096, mb);
    expect(estimate.rate()).toBeNull();
  });
});

function host(initial: { background: number; limit: number }) {
  const files = new Map<string, string>([
    ["proc/self/smaps", "KernelPageSize:        4 kB\n"],
    ["proc/sys/vm/dirty_background_bytes", `${initial.background}\n`],
    ["proc/sys/vm/dirty_bytes", `${initial.limit}\n`],
  ]);
  let written = 0;
  const set = (backlog: number, more: number) => {
    written += more;
    files.set(
      "proc/meminfo",
      `MemTotal:       ${(128 * gb) / 1024} kB\nDirty:          ${backlog / 1024} kB\nWriteback:      0 kB\n`,
    );
    files.set("proc/vmstat", `nr_written ${written}\n`);
  };
  set(0, 0);
  const applied: WritebackLimits[] = [];
  const logs: string[] = [];
  const writeback = createWriteback({
    apply: async (limits) => {
      applied.push(limits);
    },
    log: (message) => logs.push(message),
    read: async (path) => files.get(path) ?? null,
    sampleMs: 5_000,
    minApplyMs: 60_000,
  });
  return { writeback, applied, logs, set };
}

describe("createWriteback", () => {
  it("sets the floor where the kernel holds a share of memory", async () => {
    const { writeback, applied, logs } = host({ background: 0, limit: 0 });
    await writeback.start();
    writeback.stop();
    expect(applied).toEqual([{ backgroundBytes: 8 * mb, bytes: 32 * mb }]);
    expect(logs).toEqual([
      "Writing out from 8 MB held back, at most 32 MB until the disks have been seen writing",
    ]);
  });

  it("keeps the limits in bytes it finds after a restart", async () => {
    vi.useFakeTimers();
    const { writeback, applied, set } = host({
      background: 1.5 * gb,
      limit: 6 * gb,
    });
    await writeback.start();
    // Writing that never holds back as much as the limit says nothing new.
    for (let i = 0; i < 30; i++) {
      set(10 * mb, 1_000);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    writeback.stop();
    expect(applied).toEqual([]);
    expect(writeback.applied()).toEqual({
      backgroundBytes: 1.5 * gb,
      bytes: 6 * gb,
    });
  });

  it("raises the limits once a fast disk is seen writing out", async () => {
    vi.useFakeTimers();
    const { writeback, applied, logs, set } = host({ background: 0, limit: 0 });
    await writeback.start();
    // 2 GiB a second, with 20 MB held back all along, for a minute.
    const pagesIn5s = (2 * gb * 5) / 4096;
    for (let i = 0; i < 12; i++) {
      set(20 * mb, pagesIn5s);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    writeback.stop();
    expect(applied).toEqual([
      { backgroundBytes: 8 * mb, bytes: 32 * mb },
      { backgroundBytes: 1 * gb, bytes: 4 * gb },
    ]);
    expect(logs.at(-1)).toBe(
      "Writing out from 1.0 GB held back, at most 4.0 GB, for disks writing 2.0 GB/s",
    );
  });

  it("leaves an SD card at the floor", async () => {
    vi.useFakeTimers();
    const { writeback, applied, set } = host({ background: 0, limit: 0 });
    await writeback.start();
    const pagesIn5s = (7 * mb * 5) / 4096;
    for (let i = 0; i < 24; i++) {
      set(30 * mb, pagesIn5s);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    writeback.stop();
    expect(writeback.rate()).toBeCloseTo(7 * mb);
    expect(applied).toEqual([{ backgroundBytes: 8 * mb, bytes: 32 * mb }]);
  });

  it("keeps going when the helper fails, and tries again later", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    let tries = 0;
    const files = new Map<string, string>([
      ["proc/sys/vm/dirty_background_bytes", "0\n"],
      ["proc/sys/vm/dirty_bytes", "0\n"],
      ["proc/meminfo", "MemTotal: 8388608 kB\nDirty: 0 kB\nWriteback: 0 kB\n"],
      ["proc/vmstat", "nr_written 0\n"],
    ]);
    const writeback = createWriteback({
      apply: async () => {
        tries += 1;
        if (tries <= 2) throw new Error("Docker is busy");
      },
      log: (message) => logs.push(message),
      read: async (path) => files.get(path) ?? null,
      sampleMs: 5_000,
      minApplyMs: 60_000,
    });
    await writeback.start();
    expect(logs).toEqual([
      "Could not limit what waits to be written: Docker is busy",
    ]);
    await vi.advanceTimersByTimeAsync(125_000);
    writeback.stop();
    expect(tries).toBe(3);
    expect(logs).toHaveLength(2);
    expect(writeback.applied()).toEqual({
      backgroundBytes: 8 * mb,
      bytes: 32 * mb,
    });
  });

  it("does nothing without the host's /proc", async () => {
    const logs: string[] = [];
    const writeback = createWriteback({
      apply: async () => {
        throw new Error("not expected");
      },
      log: (message) => logs.push(message),
      read: async () => null,
    });
    await writeback.start();
    writeback.stop();
    expect(logs).toEqual([
      "Not limiting what waits to be written: no /proc/meminfo",
    ]);
  });
});

type HelperDocker = Parameters<typeof createWritebackHelper>[0]["docker"];

describe("createWritebackHelper", () => {
  function docker(options: { stale?: boolean; exitCode?: number } = {}) {
    const created: ContainerCreateOptions[] = [];
    const events: string[] = [];
    const containers = new Map<string, { Image: string; Labels: object }>([
      ["sanctum-manager", { Image: "sha256:manager", Labels: {} }],
    ]);
    if (options.stale) {
      containers.set("sanctum-writeback", {
        Image: "sha256:old",
        Labels: { "sanctum.managed": "true", "sanctum.role": "writeback" },
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
          containers.delete(name);
        },
        rename: async () => undefined,
        stop: async () => undefined,
        update: async () => undefined,
        wait: async () => {
          events.push(`wait ${name}`);
          return { StatusCode: options.exitCode ?? 0 };
        },
      }),
    };
    return fake as unknown as Pick<typeof fake, "created" | "events"> &
      HelperDocker;
  }

  it("writes both limits from a privileged helper with no network", async () => {
    const fake = docker({ stale: true });
    await createWritebackHelper({ docker: fake })({
      backgroundBytes: 8 * mb,
      bytes: 32 * mb,
    });
    expect(fake.created).toHaveLength(1);
    const [create] = fake.created;
    expect(create).toMatchObject({
      name: "sanctum-writeback",
      Image: "sha256:manager",
      Entrypoint: ["sh", "-c"],
      Cmd: [
        "echo 8388608 > /proc/sys/vm/dirty_background_bytes && echo 33554432 > /proc/sys/vm/dirty_bytes",
      ],
      Labels: { "sanctum.managed": "true", "sanctum.role": "writeback" },
      HostConfig: { Privileged: true, NetworkMode: "none" },
    });
    expect(create!.HostConfig).not.toHaveProperty("Binds");
    expect(fake.events).toEqual([
      "remove sanctum-writeback",
      "start sanctum-writeback",
      "wait sanctum-writeback",
      "remove sanctum-writeback",
    ]);
  });

  it("fails when the helper does, and removes it", async () => {
    const fake = docker({ exitCode: 1 });
    await expect(
      createWritebackHelper({ docker: fake })({
        backgroundBytes: 8 * mb,
        bytes: 32 * mb,
      }),
    ).rejects.toThrow("its helper ended with 1");
    expect(fake.events.at(-1)).toBe("remove sanctum-writeback");
  });
});
