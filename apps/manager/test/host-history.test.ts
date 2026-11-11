import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHostHistory, type HostSample } from "../src/host/history.js";
import { createHostReadings } from "../src/host/readings.js";
import { createHostStatus } from "../src/host/status.js";
import { createServer } from "../src/server.js";

// Settings → Status' last 24 hours: each 5 minutes' mean of the samples the
// manager takes every 10 seconds, kept across its restarts.

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const minute = 60_000;

async function history(at: { value: number }) {
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-history-"));
  return {
    dataDir,
    history: createHostHistory({
      dataDir,
      log: () => undefined,
      now: () => new Date(at.value),
    }),
  };
}

describe("the host's day", () => {
  it("keeps each ended 5 minutes' mean, and nothing for one under way", async () => {
    const at = { value: Date.parse("2026-11-02T18:10:00Z") };
    const { history: day } = await history(at);
    day.add({ usage: 0.5, celsius: 60, memoryUsed: 1_000 });
    at.value += 10_000;
    day.add({ usage: 0.7, celsius: 62, memoryUsed: 3_000 });
    expect(day.points()).toEqual([]);

    at.value = Date.parse("2026-11-02T18:15:20Z");
    day.add({ usage: 0.1, celsius: 55, memoryUsed: 2_000 });
    expect(day.points()).toEqual([
      {
        at: "2026-11-02T18:10:00.000Z",
        usage: 0.6,
        celsius: 61,
        memoryUsed: 2_000,
      },
    ]);
  });

  it("leaves out what wasn't read, and a period nothing was sampled in", async () => {
    const at = { value: Date.parse("2026-11-02T02:05:00Z") };
    const { history: day } = await history(at);
    day.add({ usage: null, celsius: 50, memoryUsed: null });
    // The manager was stopped from 02:10 to 02:40.
    at.value = Date.parse("2026-11-02T02:40:00Z");
    day.add({ usage: 0.2, celsius: 51, memoryUsed: 900 });
    expect(day.points()).toEqual([
      {
        at: "2026-11-02T02:05:00.000Z",
        usage: null,
        celsius: 50,
        memoryUsed: null,
      },
    ]);
  });

  it("forgets what is older than a day", async () => {
    const at = { value: Date.parse("2026-11-01T18:00:00Z") };
    const { history: day } = await history(at);
    day.add({ usage: 0.1, celsius: 50, memoryUsed: 1 });
    at.value += 5 * minute;
    day.add({ usage: 0.1, celsius: 50, memoryUsed: 1 });
    expect(day.points()).toHaveLength(1);
    at.value += 24 * 60 * minute;
    expect(day.points()).toEqual([]);
  });

  it("keeps the day across a restart, and ignores a damaged file", async () => {
    const at = { value: Date.parse("2026-11-02T18:00:00Z") };
    const first = await history(at);
    first.history.add({ usage: 0.3, celsius: 57, memoryUsed: 640 });
    at.value += 5 * minute;
    first.history.add({ usage: 0.3, celsius: 57, memoryUsed: 640 });
    await first.history.save();
    expect(
      JSON.parse(
        await readFile(join(first.dataDir, "host-history.json"), "utf8"),
      ).points,
    ).toHaveLength(1);

    const again = createHostHistory({
      dataDir: first.dataDir,
      log: () => undefined,
      now: () => new Date(at.value),
    });
    await again.load();
    expect(again.points()).toEqual(first.history.points());

    await writeFile(join(first.dataDir, "host-history.json"), "{not json");
    await again.load();
    expect(again.points()).toEqual([]);
  });

  it("saves by itself every 15 minutes", async () => {
    const at = { value: Date.parse("2026-11-02T18:00:00Z") };
    const { dataDir, history: day } = await history(at);
    for (let period = 0; period <= 3; period++) {
      at.value = Date.parse("2026-11-02T18:00:00Z") + period * 5 * minute;
      day.add({ usage: 0.1, celsius: 50, memoryUsed: 1 });
    }
    // It saves in the background, and a real sync takes its time.
    const saved = await vi.waitFor(
      async () =>
        JSON.parse(await readFile(join(dataDir, "host-history.json"), "utf8")),
      { timeout: 10_000 },
    );
    expect(saved.points).toHaveLength(3);
  });

  it("retries a failed save when the next period ends", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sanctum-history-"));
    const path = join(dataDir, "host-history.json");
    // A directory in place of the file makes the atomic rename fail.
    await mkdir(path);
    const logs: string[] = [];
    let at = Date.parse("2026-11-02T18:00:00Z");
    const day = createHostHistory({
      dataDir,
      now: () => new Date(at),
      log: (message) => logs.push(message),
    });
    for (let period = 0; period <= 3; period++) {
      day.add({ usage: 0.1, celsius: 50, memoryUsed: 1 });
      at += 5 * minute;
    }
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    await rm(path, { recursive: true });
    day.add({ usage: 0.2, celsius: 51, memoryUsed: 2 });
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(path, "utf8")).points).toHaveLength(4);
    });
  });

  it("takes each of the status' 10-second samples, with the temperature and the memory in use", async () => {
    const root = await mkdtemp(join(tmpdir(), "sanctum-host-"));
    const files: Record<string, string> = {
      "proc/stat": "cpu  100 0 0 900 0 0 0 0 0 0\n",
      "proc/meminfo":
        "MemTotal:        8007400 kB\nMemAvailable:    7365644 kB\nSwapTotal:       0 kB\nSwapFree:        0 kB\n",
      "sys/class/thermal/thermal_zone0/temp": "57452\n",
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const samples: HostSample[] = [];
    const status = createHostStatus({
      readings: createHostReadings({ root }),
      dataDir: root,
      channel: "dev",
      clock: async () => true,
      history: { add: (sample) => samples.push(sample) },
      log: () => undefined,
    });
    await status.sample();
    await writeFile(join(root, "proc/stat"), "cpu  150 0 0 950 0 0 0 0 0 0\n");
    await status.sample();
    expect(samples).toEqual([
      { usage: null, celsius: 57.5, memoryUsed: 641_756 * 1024 },
      { usage: 0.5, celsius: 57.5, memoryUsed: 641_756 * 1024 },
    ]);
  });

  it("answers on GET /api/host/history", async () => {
    const server = createServer(
      { version: "dev-test" },
      {
        history: {
          points: () => [
            {
              at: "2026-11-02T18:10:00.000Z",
              usage: 0.62,
              celsius: 61,
              memoryUsed: 1_190_000_000,
            },
          ],
        },
      },
    );
    servers.push(server);
    const response = await server.inject("/api/host/history");
    expect(response.statusCode).toBe(200);
    expect(response.json().points).toHaveLength(1);

    const none = createServer({ version: "dev-test" });
    servers.push(none);
    expect((await none.inject("/api/host/history")).statusCode).toBe(503);
  });
});
