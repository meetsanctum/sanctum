import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { managedLabels } from "../docker-resources.js";
import {
  errorMessage,
  isNotFound,
  type DockerClientLike,
  type WaitableContainerLike,
} from "../docker.js";
import { prepareManagerHelper } from "../manager-helper.js";
import { stacked } from "../stack.js";
import { memoryField } from "./readings.js";
import type { DiskWrites } from "./writeback-disk.js";

// How much the host's kernel may hold back from its disks. A save waits for
// everything written before it, so what's held back is how long a save can
// wait: unpacking a large image left about 800 MB on a Pi whose SD card writes
// 5–7 MB/s, and the core's and the apps' saves waited up to two minutes. The
// kernel's own limits are a share of memory, which knows nothing of the disk.
//
// Here they're time instead: writing out starts with half a second's worth
// held back, and whoever writes waits once there are two seconds' worth, at
// the speed Sanctum's disk was seen writing out. Until it has been, it's the
// floor, which suits the slowest disk, and never more than the kernel's own
// share of memory. The kernel forgets them when it restarts, and the manager
// sets them again when it starts.
const mebibyte = 1024 * 1024;
const floor = { background: 8 * mebibyte, limit: 32 * mebibyte };
const seconds = { background: 0.5, limit: 2 };
const kernelShare = { background: 0.1, limit: 0.2 };
const weight = 0.3;
const worthChanging = 0.25;
const sampleMs = 5_000;
const minApplyMs = 60_000;
const startupMs = 10_000;

export type WritebackLimits = { backgroundBytes: number; bytes: number };

export function limitsFor(
  rate: number | null,
  memoryBytes: number,
  pageSize = 4096,
): WritebackLimits {
  const pick = (part: "background" | "limit", minimumPages: number) => {
    const wanted = Math.max(floor[part], (rate ?? 0) * seconds[part]);
    const ceilingPages = Math.floor(
      (memoryBytes * kernelShare[part]) / pageSize,
    );
    // The kernel rejects a dirty limit below two pages.
    if (ceilingPages < minimumPages) return minimumPages * pageSize;
    return Math.min(Math.round(wanted), ceilingPages * pageSize);
  };
  return { backgroundBytes: pick("background", 1), bytes: pick("limit", 2) };
}

export function backlogOf(meminfo: string) {
  const dirty = memoryField(meminfo, "Dirty");
  const writeback = memoryField(meminfo, "Writeback");
  return dirty === null || writeback === null ? null : dirty + writeback;
}

function vmPages(vmstat: string, name: string) {
  const match = new RegExp(`^${name} (\\d+)$`, "m").exec(vmstat);
  return match ? Number(match[1]) : null;
}

// What the kernel's own shares are of, near enough: the memory free or
// holding file cache it can take back, as MemAvailable estimates it.
export function memoryOf(meminfo: string) {
  return memoryField(meminfo, "MemAvailable");
}

export function pageSizeOf(smaps: string) {
  const match = /^KernelPageSize:[ \t]+(\d+) kB$/m.exec(smaps);
  return match ? Number(match[1]) * 1024 : 4096;
}

type Sample = {
  at: number;
  written: number;
  backlog: number;
  disk: DiskWrites;
};

function createRateEstimate() {
  let last: Sample | null = null;
  let rate: number | null = null;
  return {
    rate: () => rate,
    reset() {
      last = null;
      rate = null;
    },
    add(sample: Sample, pageSize: number, backgroundBytes: number) {
      const before = last;
      last = sample;
      if (!before) return;
      const elapsed = sample.at - before.at;
      if (elapsed <= 0 || sample.written < before.written) return;
      if (
        Math.min(before.backlog, sample.backlog) <
        Math.max(pageSize, backgroundBytes)
      )
        return;
      // A backlog at both ends can be two bursts with an idle gap between.
      // I/O time counts overlap once, while time writing excludes reads.
      if (
        Math.min(
          sample.disk.busyMs - before.disk.busyMs,
          sample.disk.writeMs - before.disk.writeMs,
        ) <
        0.8 * elapsed
      )
        return;
      const bytes = Math.min(
        (sample.written - before.written) * pageSize,
        sample.disk.bytes - before.disk.bytes,
      );
      if (bytes <= 0) return;
      const seen = bytes / (elapsed / 1000);
      rate = rate === null ? seen : rate + weight * (seen - rate);
    },
  };
}

export const writebackContainerName = stacked("sanctum-writeback");
export const writebackRole = "writeback";
const backgroundPath = "proc/sys/vm/dirty_background_bytes";
const dirtyPath = "proc/sys/vm/dirty_bytes";

export function createWritebackHelper(options: {
  docker: Pick<DockerClientLike, "createContainer"> & {
    getContainer: (id: string) => WaitableContainerLike;
  };
  log: (message: string) => void;
}) {
  const { docker, log } = options;
  return async ({ backgroundBytes, bytes }: WritebackLimits) => {
    const image = await prepareManagerHelper(
      docker,
      writebackContainerName,
      writebackRole,
    );
    const { id } = await docker.createContainer({
      name: writebackContainerName,
      Image: image,
      Entrypoint: ["sh", "-c"],
      Cmd: [
        'echo "$1" > /dirty-background-bytes && echo "$2" > /dirty-bytes',
        "writeback",
        String(backgroundBytes),
        String(bytes),
      ],
      Labels: managedLabels(writebackRole),
      // Bind outside /proc, which Docker mounts read-only. The two files
      // are writable by root without granting access to other host settings.
      HostConfig: {
        NetworkMode: "none",
        CapDrop: ["ALL"],
        ReadonlyRootfs: true,
        Binds: [
          `/${backgroundPath}:/dirty-background-bytes:rw`,
          `/${dirtyPath}:/dirty-bytes:rw`,
        ],
      },
    });
    const helper = docker.getContainer(id);
    try {
      await helper.start();
      const { StatusCode } = await helper.wait();
      if (StatusCode !== 0) {
        throw new Error(`its helper ended with ${StatusCode}`);
      }
    } finally {
      await helper.remove({ force: true }).catch((error: unknown) => {
        if (!isNotFound(error))
          log(`Could not remove the writeback helper: ${errorMessage(error)}`);
      });
    }
  };
}

const format = (bytes: number) =>
  bytes >= 1024 * mebibyte
    ? `${(bytes / (1024 * mebibyte)).toFixed(1)} GB`
    : `${Math.round(bytes / mebibyte)} MB`;

export function createWriteback(options: {
  apply: (limits: WritebackLimits) => Promise<void>;
  readDisk: () => Promise<DiskWrites | null>;
  log: (message: string) => void;
  read?: (path: string) => Promise<string | null>;
}) {
  const { apply, log, readDisk } = options;
  const read =
    options.read ??
    ((path: string) => readFile(join("/", path), "utf8").catch(() => null));
  const estimate = createRateEstimate();
  let pageSize = 4096;
  let backingDisk: string | null = null;
  let backingChanged = false;
  let applied: WritebackLimits | null = null;
  let appliedAt = -Infinity;
  let applying: Promise<void> | null = null;
  let failing = false;
  let sampling = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const differs = (a: WritebackLimits, b: WritebackLimits) =>
    Math.abs(a.bytes - b.bytes) > worthChanging * b.bytes ||
    Math.abs(a.backgroundBytes - b.backgroundBytes) >
      worthChanging * b.backgroundBytes;

  const exceeds = (a: WritebackLimits, b: WritebackLimits) =>
    a.bytes > b.bytes || a.backgroundBytes > b.backgroundBytes;

  function set(wanted: WritebackLimits) {
    appliedAt = performance.now();
    const rate = estimate.rate();
    const device = backingDisk;
    applying = Promise.resolve()
      .then(() => apply(wanted))
      .then(() => {
        applied = wanted;
        if (device === backingDisk) backingChanged = false;
        failing = false;
        log(
          `Writing out from ${format(wanted.backgroundBytes)} held back, at most ${format(wanted.bytes)}` +
            (rate === null ? "" : `, for a disk writing ${format(rate)}/s`),
        );
      })
      .catch((error: unknown) => {
        if (!failing) {
          log(
            `Could not limit what waits to be written: ${errorMessage(error)}`,
          );
        }
        failing = true;
      })
      .finally(() => (applying = null));
    return applying;
  }

  async function sample() {
    const [meminfo, vmstat, disk] = await Promise.all([
      read("proc/meminfo"),
      read("proc/vmstat"),
      readDisk(),
    ]);
    if (!meminfo || !vmstat || stopped) return;
    const memory = memoryOf(meminfo);
    if (memory === null) return;

    const backlog = backlogOf(meminfo);
    const written = vmPages(vmstat, "nr_written");
    const backgroundPages = vmPages(vmstat, "nr_dirty_background_threshold");
    const background =
      applied?.backgroundBytes ||
      (backgroundPages === null ? null : backgroundPages * pageSize);
    const device = disk?.disk ?? null;
    if (device !== backingDisk) {
      estimate.reset();
      backingDisk = device;
      backingChanged = true;
    }
    if (disk && backlog !== null && written !== null && background !== null) {
      estimate.add(
        { at: performance.now(), written, backlog, disk },
        pageSize,
        background,
      );
    }
    const rate = estimate.rate();
    const wanted = limitsFor(rate, memory, pageSize);
    const ceiling =
      disk && !backingChanged ? limitsFor(Infinity, memory, pageSize) : wanted;
    // Memory moves all the time: only a limit well above the ceiling comes
    // down at once.
    const mustLower =
      applied !== null &&
      exceeds(applied, ceiling) &&
      differs(ceiling, applied);
    if (applying) return;
    if (!mustLower && applied && (rate === null || !differs(wanted, applied)))
      return;
    if ((!mustLower || failing) && performance.now() - appliedAt < minApplyMs)
      return;
    // The timer continues to sample while the helper is running. set() owns
    // the pending attempt until Docker confirms it has finished.
    void set(wanted);
  }

  async function initialize() {
    const [smaps, meminfo, background, limit, disk] = await Promise.all([
      read("proc/self/smaps"),
      read("proc/meminfo"),
      read(backgroundPath),
      read(dirtyPath),
      readDisk(),
    ]);
    if (stopped) return;
    if (smaps) pageSize = pageSizeOf(smaps);
    backingDisk = disk?.disk ?? null;
    const memory = meminfo ? memoryOf(meminfo) : null;
    if (memory === null) {
      log("Not limiting what waits to be written: no /proc/meminfo");
      return;
    }
    const found = {
      backgroundBytes: Number.parseInt(background ?? "", 10),
      bytes: Number.parseInt(limit ?? "", 10),
    };
    if (found.bytes > 0 && Number.isFinite(found.backgroundBytes))
      applied = found;
    const ceiling = limitsFor(disk ? Infinity : null, memory, pageSize);
    const initial =
      !applied || exceeds(applied, ceiling)
        ? set(limitsFor(null, memory, pageSize))
        : undefined;
    timer = setInterval(() => {
      if (sampling) return;
      sampling = true;
      sample()
        .catch((error: unknown) =>
          log(
            `Could not read what waits to be written: ${errorMessage(error)}`,
          ),
        )
        .finally(() => (sampling = false));
    }, sampleMs);
    timer.unref();
    await initial;
  }

  return {
    async start() {
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          initialize(),
          new Promise<void>((resolve) => {
            deadline = setTimeout(() => {
              log("Timed out waiting for the writeback limits at startup");
              resolve();
            }, startupMs);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    rate: () => estimate.rate(),
    applied: () => applied,
  };
}
