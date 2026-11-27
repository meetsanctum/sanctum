import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHostReadings, writeoutOf } from "../src/host/readings.js";
import { createHostStatus } from "../src/host/status.js";
import { createServer } from "../src/server.js";

// Whether the host is writing out a backlog of the page cache, as the manager
// reports it on GET /api/host/writeout: Dirty and Writeback from
// /proc/meminfo against where the kernel starts writing out in the
// background.

const mb = 1024 * 1024;
const kb = 1024;

// An 8 GB Pi's meminfo, with `dirty` and `writeback` in kB.
const meminfo = (dirty: number, writeback = 0) =>
  [
    "MemTotal:        8007400 kB",
    "MemFree:         2000000 kB",
    "MemAvailable:    7365644 kB",
    "Active(file):    1500000 kB",
    "Inactive(file):  2500000 kB",
    `Dirty:           ${dirty} kB`,
    `Writeback:       ${writeback} kB`,
    "",
  ].join("\n");

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// A host's /proc, under a folder of its own.
async function host(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "sanctum-writeout-"));
  roots.push(root);
  const set = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  for (const [path, text] of Object.entries(files)) await set(path, text);
  const status = createHostStatus({
    readings: createHostReadings({ root }),
    dataDir: root,
    channel: "dev",
    clock: async () => true,
    log: () => undefined,
  });
  const server = createServer({ version: "test" }, { status });
  servers.push(server);
  return { set, server };
}

describe("the host's writeout", () => {
  it("is under way once dirty and writeback pages pass the background bytes", () => {
    expect(writeoutOf(meminfo(6 * 1024, 1024), 8 * mb, 0)).toEqual({
      pendingBytes: 7 * mb,
      thresholdBytes: 8 * mb,
      writingOut: false,
    });
    expect(writeoutOf(meminfo(6 * 1024, 3 * 1024), 8 * mb, 0)).toEqual({
      pendingBytes: 9 * mb,
      thresholdBytes: 8 * mb,
      writingOut: true,
    });
  });

  // The kernel's ratio is of what is free and what holds files' pages,
  // 6 GB here, so 10 % is 600 MB.
  it("takes the background ratio of the memory that may hold dirty pages when the bytes are 0", () => {
    const threshold = 600_000 * kb;

    expect(writeoutOf(meminfo(500_000), 0, 10)).toEqual({
      pendingBytes: 500_000 * kb,
      thresholdBytes: threshold,
      writingOut: false,
    });
    expect(writeoutOf(meminfo(550_000, 100_000), 0, 10)).toMatchObject({
      pendingBytes: 650_000 * kb,
      writingOut: true,
    });
  });

  it("can't say without the counters or a threshold", () => {
    expect(writeoutOf("MemTotal: 8007400 kB\n", 8 * mb, 0)).toBeNull();
    expect(writeoutOf(meminfo(10), null, null)).toBeNull();
  });

  it("is served from what the kernel says, read again with each question", async () => {
    const { set, server } = await host({
      "proc/meminfo": meminfo(800_000, 20_000),
      "proc/sys/vm/dirty_background_bytes": "0\n",
      "proc/sys/vm/dirty_background_ratio": "10\n",
    });

    const during = await server.inject("/api/host/writeout");

    expect(during.statusCode).toBe(200);
    expect(during.json()).toEqual({
      pendingBytes: 820_000 * kb,
      thresholdBytes: 600_000 * kb,
      writingOut: true,
    });

    // The threshold changes as the host runs, as the backlog does.
    await set("proc/sys/vm/dirty_background_bytes", `${1024 * mb}\n`);
    await set("proc/sys/vm/dirty_background_ratio", "0\n");
    expect((await server.inject("/api/host/writeout")).json()).toMatchObject({
      thresholdBytes: 1024 * mb,
      writingOut: false,
    });
  });

  it("says when it can't tell", async () => {
    const { server } = await host({ "proc/meminfo": meminfo(10) });

    const response = await server.inject("/api/host/writeout");

    expect(response.statusCode).toBe(503);
  });

  it("is answered by no manager that reports no host", async () => {
    const server = createServer({ version: "test" });
    servers.push(server);

    expect((await server.inject("/api/host/writeout")).statusCode).toBe(503);
  });
});
