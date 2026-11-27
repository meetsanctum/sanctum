import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { assertManaged, managedLabels } from "../docker-resources.js";
import {
  errorMessage,
  inspectContainer,
  type DockerClientLike,
  type WaitableContainerLike,
} from "../docker.js";
import { stacked } from "../stack.js";
import { managerContainerName } from "../update/manager-update.js";

// How much the host's kernel may hold back from its disks. A save waits for
// everything written before it, so what's held back is how long a save can
// wait: unpacking a large image left about 800 MB on a Pi whose SD card writes
// 7 MB/s, and the core's and the apps' saves waited up to two minutes. The
// kernel's own limits are a share of memory, which knows nothing of the disk,
// so they hold a few seconds' writing on a fast disk and minutes on a slow one.
//
// Here they're time instead: writing out starts with half a second's worth
// held back, and whoever writes waits once there are two seconds' worth, at
// the speed the disks were seen writing out. Until they have been, it's the
// floor, which suits the slowest disk, and never more than the kernel's own
// share of memory. The kernel forgets them when it restarts, and the manager
// sets them again when it starts.

const mebibyte = 1024 * 1024;
const floor = { background: 8 * mebibyte, limit: 32 * mebibyte };
const seconds = { background: 0.5, limit: 2 };
// The kernel's own shares, of the memory that can hold unwritten data; here
// of all of it, which moves less.
const kernelShare = { background: 0.1, limit: 0.2 };
// How much a new estimate moves the one kept, so one odd sample does little.
const weight = 0.3;
// A change smaller than this isn't worth starting a helper for.
const worthChanging = 0.25;
const defaultSampleMs = 5_000;
const defaultMinApplyMs = 60_000;

export type WritebackLimits = { backgroundBytes: number; bytes: number };

/** The limits for a disk that writes out `rate` bytes a second (null: not seen yet). */
export function limitsFor(
  rate: number | null,
  memoryBytes: number,
): WritebackLimits {
  const pick = (part: "background" | "limit") => {
    const wanted =
      rate === null ? floor[part] : Math.max(floor[part], rate * seconds[part]);
    // A machine with little memory keeps the kernel's own, which is smaller.
    const ceiling = Math.floor(memoryBytes * kernelShare[part]);
    return Math.round(Math.min(wanted, ceiling));
  };
  return { backgroundBytes: pick("background"), bytes: pick("limit") };
}

// Dirty and Writeback from /proc/meminfo: what's waiting to be written, or
// being written.
export function backlogOf(meminfo: string) {
  let total = 0;
  for (const name of ["Dirty", "Writeback"]) {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(meminfo);
    if (!match) return null;
    total += Number(match[1]) * 1024;
  }
  return total;
}

export function memoryOf(meminfo: string) {
  const match = /^MemTotal:\s+(\d+) kB$/m.exec(meminfo);
  return match ? Number(match[1]) * 1024 : null;
}

// Pages written out since the host started, from /proc/vmstat.
export function pagesWrittenOf(vmstat: string) {
  const match = /^nr_written (\d+)$/m.exec(vmstat);
  return match ? Number(match[1]) : null;
}

// The kernel's page size, which differs between machines (4 KiB, or 16 KiB
// on a Raspberry Pi 5).
export function pageSizeOf(smaps: string) {
  const match = /^KernelPageSize:\s+(\d+) kB$/m.exec(smaps);
  return match ? Number(match[1]) * 1024 : 4096;
}

type Sample = { at: number; written: number; backlog: number };

/**
 * The speed the disks write out at, from samples a while apart. Only an
 * interval with unwritten data held back from start to end counts: then the
 * kernel was writing out all along, so what it wrote is what the disks can.
 */
export function createRateEstimate() {
  let last: Sample | null = null;
  let rate: number | null = null;
  return {
    rate: () => rate,
    add(sample: Sample, pageSize: number, backgroundBytes: number) {
      const before = last;
      last = sample;
      if (!before || sample.at <= before.at) return;
      if (sample.written < before.written) return;
      if (before.backlog < backgroundBytes || sample.backlog < backgroundBytes)
        return;
      const seen =
        ((sample.written - before.written) * pageSize) /
        ((sample.at - before.at) / 1000);
      rate = rate === null ? seen : rate + weight * (seen - rate);
    },
  };
}

export const writebackContainerName = stacked("sanctum-writeback");
export const writebackRole = "writeback";

/**
 * Sets the kernel's limits through a short privileged helper from the
 * manager's own image: the manager's container can read them but not change
 * them, and they belong to the whole machine. It has no network and nothing
 * mounted.
 */
export function createWritebackHelper(options: {
  docker: Pick<DockerClientLike, "createContainer"> & {
    getContainer: (id: string) => WaitableContainerLike;
  };
}) {
  const { docker } = options;
  return async (limits: WritebackLimits) => {
    const manager = await inspectContainer(docker, managerContainerName);
    if (!manager) {
      throw new Error(`No ${managerContainerName} container to start from`);
    }
    const stale = await inspectContainer(docker, writebackContainerName);
    if (stale) {
      assertManaged(
        { labels: stale.Config.Labels, name: stale.Name },
        writebackRole,
      );
      await docker.getContainer(stale.Id).remove({ force: true });
    }
    const { id } = await docker.createContainer({
      name: writebackContainerName,
      Image: manager.Image,
      Entrypoint: ["sh", "-c"],
      // Setting a limit in bytes turns its share of memory off.
      Cmd: [
        `echo ${limits.backgroundBytes} > /proc/sys/vm/dirty_background_bytes && echo ${limits.bytes} > /proc/sys/vm/dirty_bytes`,
      ],
      Labels: managedLabels(writebackRole),
      HostConfig: { Privileged: true, NetworkMode: "none" },
    });
    const helper = docker.getContainer(id);
    try {
      await helper.start();
      const { StatusCode } = await helper.wait();
      if (StatusCode !== 0) {
        throw new Error(`its helper ended with ${StatusCode}`);
      }
    } finally {
      await helper.remove({ force: true }).catch(() => undefined);
    }
  };
}

const format = (bytes: number) =>
  bytes >= 1024 * mebibyte
    ? `${(bytes / (1024 * mebibyte)).toFixed(1)} GB`
    : `${Math.round(bytes / mebibyte)} MB`;

export function createWriteback(options: {
  apply: (limits: WritebackLimits) => Promise<void>;
  log: (message: string) => void;
  // Reads a file of the host's /proc, null where it can't; for tests.
  read?: (path: string) => Promise<string | null>;
  now?: () => number;
  sampleMs?: number;
  minApplyMs?: number;
}) {
  const { apply, log } = options;
  const read =
    options.read ??
    ((path: string) => readFile(join("/", path), "utf8").catch(() => null));
  const now = options.now ?? Date.now;
  const sampleMs = options.sampleMs ?? defaultSampleMs;
  const minApplyMs = options.minApplyMs ?? defaultMinApplyMs;
  const estimate = createRateEstimate();
  let pageSize = 4096;
  let applied: WritebackLimits | null = null;
  let appliedAt = -Infinity;
  let applying: Promise<void> | null = null;
  let failing = false;
  let timer: NodeJS.Timeout | undefined;

  async function current(): Promise<WritebackLimits | null> {
    const [background, limit] = await Promise.all([
      read("proc/sys/vm/dirty_background_bytes"),
      read("proc/sys/vm/dirty_bytes"),
    ]);
    const backgroundBytes = Number.parseInt(background ?? "", 10);
    const bytes = Number.parseInt(limit ?? "", 10);
    if (!Number.isFinite(backgroundBytes) || !Number.isFinite(bytes)) {
      return null;
    }
    return { backgroundBytes, bytes };
  }

  const differs = (a: WritebackLimits, b: WritebackLimits) =>
    Math.abs(a.bytes - b.bytes) > worthChanging * b.bytes ||
    Math.abs(a.backgroundBytes - b.backgroundBytes) >
      worthChanging * b.backgroundBytes;

  async function set(wanted: WritebackLimits) {
    appliedAt = now();
    try {
      await apply(wanted);
      applied = wanted;
      failing = false;
      const rate = estimate.rate();
      log(
        `Writing out from ${format(wanted.backgroundBytes)} held back, at most ${format(wanted.bytes)}` +
          (rate === null
            ? " until the disks have been seen writing"
            : `, for disks writing ${format(rate)}/s`),
      );
    } catch (error) {
      // It tries again each minute, and says so once.
      if (!failing) {
        log(`Could not limit what waits to be written: ${errorMessage(error)}`);
      }
      failing = true;
    }
  }

  async function sample() {
    const [meminfo, vmstat] = await Promise.all([
      read("proc/meminfo"),
      read("proc/vmstat"),
    ]);
    const backlog = meminfo ? backlogOf(meminfo) : null;
    const memory = meminfo ? memoryOf(meminfo) : null;
    const written = vmstat ? pagesWrittenOf(vmstat) : null;
    if (backlog === null || memory === null || written === null) return;
    // Against the limit in force: until one's applied, the floor's.
    const background =
      applied?.backgroundBytes ?? limitsFor(null, memory).backgroundBytes;
    estimate.add({ at: now(), written, backlog }, pageSize, background);
    const rate = estimate.rate();
    // Nothing seen yet says what the limits in force should change to.
    if (rate === null && applied) return;
    const wanted = limitsFor(rate, memory);
    if (applying || (applied && !differs(wanted, applied))) return;
    if (now() - appliedAt < minApplyMs) return;
    applying = set(wanted).finally(() => (applying = null));
    await applying;
  }

  return {
    /** Sets the limits for disks not seen yet, unless they're set, and starts watching. */
    async start() {
      const smaps = await read("proc/self/smaps");
      if (smaps) pageSize = pageSizeOf(smaps);
      const meminfo = await read("proc/meminfo");
      const memory = meminfo ? memoryOf(meminfo) : null;
      if (memory === null) {
        log("Not limiting what waits to be written: no /proc/meminfo");
        return;
      }
      const found = await current();
      // Limits in bytes are a manager's from before it restarted, kept until
      // the disks are seen writing; the kernel's own are a share of memory
      // and none in bytes.
      if (found && found.bytes > 0) {
        applied = found;
      } else {
        await set(limitsFor(null, memory));
      }
      timer = setInterval(() => {
        sample().catch((error: unknown) =>
          log(
            `Could not read what waits to be written: ${errorMessage(error)}`,
          ),
        );
      }, sampleMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
    },
    rate: () => estimate.rate(),
    applied: () => applied,
  };
}
