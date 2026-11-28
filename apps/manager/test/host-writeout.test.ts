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
const pageSize = 16 * 1024;
const vmstat = (bytes: number) =>
  `nr_dirty_background_threshold ${bytes / pageSize}\n`;
const auxv = Buffer.alloc(48);
auxv.writeBigUInt64LE(6n, 16);
auxv.writeBigUInt64LE(BigInt(pageSize), 24);
// Another auxiliary-vector entry before AT_PAGESZ, followed by AT_NULL.
auxv.writeBigUInt64LE(3n, 0);

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
async function host(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), "sanctum-writeout-"));
  roots.push(root);
  const set = async (path: string, text: string | Buffer) => {
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
  it("adds dirty and writeback bytes and converts the kernel's threshold from pages", () => {
    expect(
      writeoutOf(meminfo(6 * 1024, 3 * 1024), vmstat(8 * mb), pageSize),
    ).toEqual({ pendingBytes: 9 * mb, thresholdBytes: 8 * mb });
  });

  it("can't say without the counters or a threshold", () => {
    expect(
      writeoutOf("MemTotal: 8007400 kB\n", vmstat(8 * mb), pageSize),
    ).toBeNull();
    expect(
      writeoutOf(meminfo(10), "nr_dirty_threshold 123\n", pageSize),
    ).toBeNull();
  });

  it("is served from what the kernel says, read again with each question", async () => {
    const { set, server } = await host({
      "proc/meminfo": meminfo(90 * 1024, 10 * 1024),
      "proc/self/auxv": auxv,
      "proc/vmstat": vmstat(64 * mb),
      "proc/sys/vm/dirty_background_bytes": `${256 * mb}\n`,
    });

    const during = await server.inject("/api/host/writeout");

    expect(during.statusCode).toBe(200);
    expect(during.json()).toEqual({
      pendingBytes: 100 * mb,
      thresholdBytes: 64 * mb,
    });

    // The threshold changes as the host runs, as the backlog does.
    await set("proc/vmstat", vmstat(1024 * mb));
    await set("proc/meminfo", meminfo(50 * 1024));
    expect((await server.inject("/api/host/writeout")).json()).toEqual({
      pendingBytes: 50 * mb,
      thresholdBytes: 1024 * mb,
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
