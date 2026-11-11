import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMaintenance } from "../src/apps/maintenance.js";
import { AppRefusal } from "../src/apps/refusal.js";

// The container that copies an app's database has a time limit, since other work on
// apps' images waits for it. Its copying and putting back are in
// app-images.docker.ts, on real images.

vi.mock("../src/durable.js", async (original) => ({
  ...(await original<typeof import("../src/durable.js")>()),
  syncFileSystem: async () => {},
}));

function dockerWith(wait: () => Promise<unknown>) {
  const remove = vi.fn(async () => undefined);
  return {
    remove,
    docker: {
      getImage: () => ({ inspect: async () => ({ Id: "node" }) }),
      createContainer: async () => ({ id: "the-helper" }),
      getContainer: () => ({
        id: "the-helper",
        inspect: async () => {
          const missing = Object.assign(new Error("No such container"), {
            statusCode: 404,
          });
          throw missing;
        },
        start: async () => undefined,
        wait,
        remove,
      }),
    } as never,
  };
}

describe("the maintenance container", () => {
  it("is given up on past its time limit, and doesn't stay behind", async () => {
    const { docker, remove } = dockerWith(() => new Promise(() => undefined));
    const maintenance = createMaintenance({
      docker,
      dataDir: await mkdtemp(join(tmpdir(), "sanctum-maintenance-")),
      nodeImage: "node",
      log: () => undefined,
      limitMs: 10,
    });

    const run = maintenance.run("test.app", "the-volume", {
      operation: "copy",
      file: "app.db",
      name: "update-1.db",
    });

    await expect(run).rejects.toThrow(AppRefusal);
    await expect(run).rejects.toThrow("in time");
    expect(remove).toHaveBeenCalledWith({ force: true, v: true });
  });

  it("says why when it ended without reporting", async () => {
    const { docker } = dockerWith(async () => ({ StatusCode: 1 }));
    const maintenance = createMaintenance({
      docker,
      dataDir: await mkdtemp(join(tmpdir(), "sanctum-maintenance-")),
      nodeImage: join("node"),
      log: () => undefined,
    });

    await expect(
      maintenance.run("test.app", "the-volume", {
        operation: "copy",
        file: "app.db",
        name: "update-1.db",
      }),
    ).rejects.toThrow("it ended without saying");
  });
});
