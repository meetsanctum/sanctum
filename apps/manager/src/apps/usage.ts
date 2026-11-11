import {
  chargedBytes,
  residentBytes,
  type ContainerStats,
  type UsageDockerLike,
} from "../docker.js";
import { appContainerName } from "./containers.js";
import type { ImageStatus } from "./images.js";

// What an app holds and uses now, for How it's running in its settings. A figure
// the host can't give is null, as they all are for one that isn't running, apart
// from its data.

export type AppUsage = {
  // What the kernel charges it, which is what its limit is held to.
  memoryBytes: number | null;
  // A percentage of one core, which is what its limit of half of one is in.
  processor: number | null;
  // What its image takes on the disk, as Status' Storage counts it.
  dataBytes: number | null;
};

function processorShare({
  cpu_stats: now,
  precpu_stats: before,
}: ContainerStats) {
  const cores = now?.online_cpus ?? 0;
  if (!now?.system_cpu_usage || !before?.system_cpu_usage || cores <= 0) {
    return null;
  }
  const used =
    (now.cpu_usage?.total_usage ?? 0) - (before.cpu_usage?.total_usage ?? 0);
  const passed = now.system_cpu_usage - before.system_cpu_usage;
  if (used < 0 || passed <= 0) return null;
  return (used / passed) * cores * 100;
}

export function createAppUsage(options: {
  docker: UsageDockerLike;
  images: { listOrNone: () => Promise<ImageStatus[]> };
}) {
  return async function appUsage(app: string): Promise<AppUsage> {
    const container = options.docker.getContainer(appContainerName(app));
    const [top, stats, images] = await Promise.all([
      container.top({ ps_args: "-o pid,rss" }).catch(() => null),
      container.stats({ stream: false }).catch(() => null),
      options.images.listOrNone(),
    ]);
    const image = images.find((each) => each.app === app);
    return {
      memoryBytes: top
        ? ((stats && chargedBytes(stats)) ?? residentBytes(top))
        : null,
      processor: top && stats ? processorShare(stats) : null,
      dataBytes: image?.state === "ok" ? image.bytes : null,
    };
  };
}
