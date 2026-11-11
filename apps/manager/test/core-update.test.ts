import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  coreContainerName,
  coreContainerOptions,
  previousCoreContainerName,
} from "../src/core-container.js";
import { createOperations } from "../src/operations.js";
import { updatePendingFile } from "../src/update/core-update.js";
import {
  createUpdateService,
  UpdateConflictError,
} from "../src/update/service.js";
import { createHost, image } from "./host.js";

describe("core update", () => {
  it("backs up, starts the new core held and commits it", async () => {
    const host = await createHost();
    host.release("dev-2");
    const before = host.docker.container(coreContainerName)!;
    let pendingAtStart: boolean | null = null;
    host.docker.onStart = (name) => {
      if (name === coreContainerName) {
        pendingAtStart = existsSync(join(host.coreDataDir, updatePendingFile));
      }
    };

    const journal = await host.update("dev-2");

    expect(journal).toMatchObject({
      phase: "done",
      outcome: "updated",
      core: { status: "updated", version: "dev-2", fromVersion: "dev-1" },
      manager: { status: "skipped" },
    });
    expect(pendingAtStart).toBe(true);
    expect(existsSync(join(host.coreDataDir, updatePendingFile))).toBe(false);
    expect(host.docker.imageOf(coreContainerName)?.labels).toMatchObject({
      "org.opencontainers.image.version": "dev-2",
    });
    expect(host.docker.container(previousCoreContainerName)).toBeUndefined();
    expect(host.committed).toEqual([
      host.docker.container(coreContainerName)!.imageId,
    ]);
    expect(await readFile(join(journal.core.backup!, "core.db"), "utf8")).toBe(
      "dev-1 data",
    );
    expect(host.docker.events).toEqual([
      `pull ${image("core", "dev-2")}`,
      `pull ${image("manager", "dev-2")}`,
      `stop ${coreContainerName}`,
      `rename ${coreContainerName} ${previousCoreContainerName}`,
      `create ${coreContainerName} dev-2`,
      `start ${coreContainerName}`,
      `remove ${previousCoreContainerName}`,
    ]);
    expect(before.id).not.toBe(host.docker.container(coreContainerName)?.id);
  });

  it("rolls back a core that never answers healthy, data and all", async () => {
    const host = await createHost();
    host.release("dev-2", { core: "unhealthy" });
    const before = host.docker.container(coreContainerName)!;
    host.docker.onStart = (name, version) => {
      if (name === coreContainerName && version === "dev-2") {
        // The new core migrates the database before it fails.
        void writeFile(join(host.coreDataDir, "core.db"), "dev-2 data");
      }
    };

    const journal = await host.update("dev-2");

    expect(journal).toMatchObject({
      outcome: "rolled-back",
      core: { status: "rolled-back" },
      manager: { status: "pending" },
    });
    expect(journal.error).toMatch(/not healthy within/);
    const core = host.docker.container(coreContainerName)!;
    expect(core.id).toBe(before.id);
    expect(core.running).toBe(true);
    expect(host.docker.container(previousCoreContainerName)).toBeUndefined();
    expect(await readFile(join(host.coreDataDir, "core.db"), "utf8")).toBe(
      "dev-1 data",
    );
    expect(existsSync(join(host.coreDataDir, updatePendingFile))).toBe(false);
    expect(host.committed).toEqual([]);
  });

  it("rolls back a core that crashes on start", async () => {
    const host = await createHost();
    host.release("dev-2", { core: "crash" });

    const journal = await host.update("dev-2");

    expect(journal.outcome).toBe("rolled-back");
    expect(journal.error).toBe(`${coreContainerName} stopped`);
    expect(host.docker.imageOf(coreContainerName)?.labels).toMatchObject({
      "org.opencontainers.image.version": "dev-1",
    });
  });

  it("changes nothing when an image cannot be pulled", async () => {
    const host = await createHost();

    const journal = await host.update("dev-2");

    expect(journal.outcome).toBe("failed");
    expect(journal.error).toMatch(/not found/);
    expect(host.docker.events).toEqual([]);
  });

  it("refuses an image that is not the core", async () => {
    const host = await createHost();
    host.release("dev-2");
    host.docker.publish(image("core", "dev-2"), {
      title: "sanctum-manager",
      version: "dev-2",
    });

    const journal = await host.update("dev-2");

    expect(journal.outcome).toBe("failed");
    expect(journal.error).toBe(
      `${image("core", "dev-2")} is not a sanctum-core image`,
    );
  });

  it("leaves an up-to-date host alone", async () => {
    const host = await createHost();
    host.docker.alias(image("core", "dev-2"), image("core", "dev-1"));
    host.docker.alias(image("manager", "dev-2"), image("manager", "dev-1"));

    const journal = await host.update("dev-2");

    expect(journal.outcome).toBe("unchanged");
    expect(host.docker.events.filter((e) => !e.startsWith("pull"))).toEqual([]);
  });

  it("runs one update at a time", async () => {
    const host = await createHost();
    host.release("dev-2");

    await host.updates.start("dev-2");
    await expect(host.updates.start("dev-2")).rejects.toThrow(
      UpdateConflictError,
    );
    await host.updates.wait();
  });

  it("keeps the newest three backups", async () => {
    const host = await createHost();
    for (const version of ["dev-2", "dev-3", "dev-4", "dev-5"]) {
      host.release(version);
      const journal = await host.update(version);
      expect(journal.outcome).toBe("updated");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const backups = await readdir(join(host.dataDir, "backups"));
    expect(backups).toHaveLength(3);
    expect(backups.some((name) => name.endsWith("-dev-1"))).toBe(false);
  });
});

describe("resuming an interrupted core update", () => {
  it("rolls back when the manager restarted during the health check", async () => {
    const host = await createHost();
    host.release("dev-2");
    const before = host.docker.container(coreContainerName)!;
    host.docker.onStart = (name, version) => {
      if (name === coreContainerName && version === "dev-2") {
        void writeFile(join(host.coreDataDir, "core.db"), "dev-2 data");
      }
    };
    // The health check hangs, as if the manager died while waiting.
    const stalled = createUpdateService({
      operations: createOperations(),
      ...host.context,
      fetch: () => new Promise<Response>(() => {}),
      config: {
        channel: "dev",
        devRegistry: "localhost:5000",
        imageOwner: "meetsanctum",
        version: "dev-1",
      },
      onCoreCommitted: async () => {},
    });
    await stalled.start("dev-2");
    while ((await host.context.journal.read())?.core.status !== "checking") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await host.updates.resume();

    const journal = (await host.context.journal.read())!;
    expect(journal).toMatchObject({
      outcome: "rolled-back",
      core: { status: "rolled-back" },
    });
    expect(host.docker.container(coreContainerName)?.id).toBe(before.id);
    expect(await readFile(join(host.coreDataDir, "core.db"), "utf8")).toBe(
      "dev-1 data",
    );
  });

  it("finishes a commit that had begun", async () => {
    const host = await createHost();
    host.release("dev-2");
    // Stage a manager that died after it started removing the update marker.
    const { docker } = host;
    await docker.pull(image("core", "dev-2"));
    await docker.getContainer(coreContainerName).stop();
    await docker.getContainer(coreContainerName).rename({
      name: previousCoreContainerName,
    });
    docker.run(coreContainerOptions(image("core", "dev-2")));
    await writeFile(join(host.coreDataDir, updatePendingFile), "crashed");
    await host.context.journal.save({
      id: "crashed",
      version: "dev-2",
      startedAt: new Date().toISOString(),
      phase: "core",
      core: {
        status: "committing",
        image: image("core", "dev-2"),
        imageId: docker.container(coreContainerName)!.imageId,
        previousContainerId: docker.container(previousCoreContainerName)!.id,
      },
      manager: {
        status: "pending",
        image: image("manager", "dev-2"),
        imageId: docker.container("sanctum-manager")?.imageId,
      },
      log: [],
    });

    await host.updates.resume();

    expect((await host.context.journal.read())?.outcome).toBe("updated");
    expect(existsSync(join(host.coreDataDir, updatePendingFile))).toBe(false);
    expect(docker.container(previousCoreContainerName)).toBeUndefined();
    expect(host.committed).toEqual([
      host.docker.container(coreContainerName)!.imageId,
    ]);
  });
});
