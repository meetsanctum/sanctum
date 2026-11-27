import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import type { UpdateJournal } from "../src/update/journal.js";

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "../../..");
const docker = async (...args: string[]) =>
  (await execFile("docker", args, { cwd: root })).stdout.trim();
const sysctl = async (...args: string[]) =>
  (await execFile("sudo", ["-n", "sysctl", ...args])).stdout.trim();

// These kernel settings are shared by all containers. This test uses its own
// Linux runner and restores both settings, including their original mode.
describe.runIf(
  process.platform === "linux" &&
    process.env.SANCTUM_TEST_HOST_WRITEBACK === "1",
)("writeback on a Linux host", () => {
  it("sets both kernel limits before resuming an interrupted update", async () => {
    const containers = ["sanctum-manager", "sanctum-writeback", "sanctum-core"];
    const existing = (await docker("ps", "-a", "--format", "{{.Names}}")).split(
      "\n",
    );
    expect(existing.filter((name) => containers.includes(name))).toEqual([]);
    const data = await mkdtemp(join(tmpdir(), "sanctum-writeback-"));
    const image = `sanctum-manager-writeback-test:${randomUUID()}`;
    const keys = ["vm.dirty_background", "vm.dirty"];
    const previous = await Promise.all(
      keys.map(async (key) => {
        const bytes = await sysctl("-n", `${key}_bytes`);
        return bytes === "0"
          ? `${key}_ratio=${await sysctl("-n", `${key}_ratio`)}`
          : `${key}_bytes=${bytes}`;
      }),
    );

    try {
      const journal: UpdateJournal = {
        id: "startup-test",
        version: "test",
        startedAt: new Date().toISOString(),
        phase: "pulling",
        core: { status: "pending", image: "sanctum-core:test" },
        manager: { status: "pending", image },
        log: [],
      };
      await writeFile(join(data, "update.json"), JSON.stringify(journal));
      // Read the live kernel values at the first recovery log entry, before
      // reconciliation can do any work.
      await writeFile(
        join(data, "observe.cjs"),
        `
          const { readFileSync } = require("node:fs");
          const log = console.log;
          console.log = (message, ...args) => {
            if (message === "update startup-test: Resuming the update") {
              const read = (name) => readFileSync("/proc/sys/vm/" + name, "utf8").trim();
              log("Writeback at recovery:", read("dirty_background_bytes"), read("dirty_bytes"));
            }
            log(message, ...args);
          };
        `,
      );
      await docker(
        "build",
        "-q",
        "-f",
        "apps/manager/Dockerfile",
        "-t",
        image,
        ".",
      );
      await sysctl("-w", "vm.dirty_background_ratio=10", "vm.dirty_ratio=20");
      await docker(
        "run",
        "-d",
        "--name",
        "sanctum-manager",
        "-e",
        "MANAGER_ANNOUNCE=false",
        "-e",
        "SANCTUM_CHANNEL=dev",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        `${data}:/data`,
        image,
        "node",
        "--require",
        "/data/observe.cjs",
        "dist/index.js",
      );

      await vi.waitFor(
        async () => {
          const logs = await docker("logs", "sanctum-manager");
          expect(logs).toContain("Writeback at recovery: 8388608 33554432");
          expect(logs).toContain("Interrupted before anything changed");
        },
        { timeout: 30_000, interval: 500 },
      );
    } finally {
      // Stop the manager first so it cannot start another helper.
      for (const name of containers) {
        await docker("rm", "-f", name).catch(() => undefined);
      }
      try {
        await sysctl("-w", ...previous);
      } finally {
        await docker("image", "rm", image).catch(() => undefined);
        await rm(data, { recursive: true, force: true });
      }
    }
  }, 600_000);
});
