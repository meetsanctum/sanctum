import { describe, expect, it } from "vitest";

import { appContainerName } from "../src/apps/containers.js";
import type { ContainerStats } from "../src/docker.js";
import type { ImageStatus } from "../src/apps/images.js";
import { createAppUsage } from "../src/apps/usage.js";

// How it's running in an app's settings: what the manager reads for it.

const app = "sanctum.weather";
const mebibyte = 1024 * 1024;

function usage(options: {
  isRunning?: boolean;
  stats?: ContainerStats;
  images?: ImageStatus[];
}) {
  const asked: string[] = [];
  return {
    asked,
    read: createAppUsage({
      docker: {
        getContainer(id) {
          asked.push(id);
          return {
            top: async () => {
              if (options.isRunning === false) {
                throw new Error("Container is not running");
              }
              return {
                Titles: ["PID", "RSS"],
                Processes: [
                  ["1", "30720"],
                  ["7", "10240"],
                ],
              };
            },
            stats: async () => options.stats ?? {},
          };
        },
      },
      images: { listOrNone: async () => options.images ?? [] },
    }),
  };
}

const reading = (used: number, passed: number, online_cpus = 4) => ({
  cpu_stats: {
    cpu_usage: { total_usage: 1_000 + used },
    system_cpu_usage: 100_000 + passed,
    online_cpus,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 1_000 },
    system_cpu_usage: 100_000,
  },
});

describe("what an app holds and uses", () => {
  it("says what the kernel charges its own container, without its file cache", async () => {
    const { read, asked } = usage({
      stats: {
        memory_stats: {
          usage: 33 * mebibyte,
          stats: { inactive_file: mebibyte },
        },
      },
    });

    expect((await read(app)).memoryBytes).toBe(32 * mebibyte);
    expect(asked).toEqual([appContainerName(app)]);
  });

  it("reads the file cache as an older kernel names it", async () => {
    const stats = {
      memory_stats: {
        usage: 33 * mebibyte,
        stats: { total_inactive_file: 3 * mebibyte },
      },
    };

    expect((await usage({ stats }).read(app)).memoryBytes).toBe(30 * mebibyte);
  });

  it("uses the whole container's cache when an older kernel gives both counts", async () => {
    const stats = {
      memory_stats: {
        usage: 33 * mebibyte,
        stats: { inactive_file: mebibyte, total_inactive_file: 3 * mebibyte },
      },
    };

    expect((await usage({ stats }).read(app)).memoryBytes).toBe(30 * mebibyte);
  });

  it("keeps the usage when a cache reading is larger than it", async () => {
    const stats = {
      memory_stats: {
        usage: 33 * mebibyte,
        stats: { inactive_file: 34 * mebibyte },
      },
    };

    expect((await usage({ stats }).read(app)).memoryBytes).toBe(33 * mebibyte);
  });

  it("adds up what its processes hold where the kernel keeps no count", async () => {
    expect((await usage({}).read(app)).memoryBytes).toBe(40 * mebibyte);
    expect(
      (await usage({ stats: { memory_stats: {} } }).read(app)).memoryBytes,
    ).toBe(40 * mebibyte);
  });

  it("says its processor as a percentage of one core", async () => {
    // A tenth of a machine of four cores is 40% of one.
    expect(
      (await usage({ stats: reading(100, 1_000) }).read(app)).processor,
    ).toBe(40);
  });

  it("gives no processor figure without two readings to compare", async () => {
    const stats = {
      ...reading(100, 1_000),
      precpu_stats: { cpu_usage: { total_usage: 0 } },
    };

    expect((await usage({ stats }).read(app)).processor).toBeNull();
  });

  it("gives its data's size from its own image, unless that isn't whole", async () => {
    const image = (state: ImageStatus["state"]): ImageStatus[] => [
      { app: "sanctum.other", state: "ok", sizeMb: 256, bytes: 1 },
      { app, state, sizeMb: 256, bytes: 9_000_000 },
    ];

    const whole = await usage({ images: image("ok") }).read(app);
    const damaged = await usage({ images: image("damaged") }).read(app);
    const none = await usage({}).read(app);

    expect(whole.dataBytes).toBe(9_000_000);
    expect(damaged.dataBytes).toBeNull();
    expect(none.dataBytes).toBeNull();
  });

  it("has only its data's size while it isn't running", async () => {
    const { read } = usage({
      isRunning: false,
      stats: reading(100, 1_000),
      images: [{ app, state: "ok", sizeMb: 256, bytes: 9_000_000 }],
    });

    expect(await read(app)).toEqual({
      memoryBytes: null,
      processor: null,
      dataBytes: 9_000_000,
    });
  });
});
