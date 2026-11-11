import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  coreContainerName,
  previousCoreContainerName,
  reconcileCore,
} from "../src/core-container.js";
import { createOperations } from "../src/operations.js";
import { createReconciler } from "../src/reconcile.js";
import {
  runUpdater,
  managerContainerName,
  previousManagerContainerName,
  updaterContainerName,
} from "../src/update/manager-update.js";
import {
  createUpdateService,
  UpdateConflictError,
} from "../src/update/service.js";
import { createHost, image } from "./host.js";

const config = {
  channel: "dev",
  devRegistry: "localhost:5000",
  imageOwner: "meetsanctum",
  version: "dev-1",
} as const;

describe("taking its turn with other operations", () => {
  const moving = {
    kind: "service-image",
    service: "zigbee2mqtt",
    to: "zigbee2mqtt:2.14.2",
  } as const;

  it("is refused while a service's change of image holds the slot", async () => {
    const host = await createHost();
    host.release("dev-2");
    const operations = createOperations();
    let holder: typeof moving | null = moving;
    operations.heldBy(() => holder);
    const updates = createUpdateService({
      ...host.context,
      operations,
      config,
      onCoreCommitted: async () => {},
    });

    await expect(updates.start("dev-2")).rejects.toThrow(UpdateConflictError);
    await expect(updates.start("dev-2")).rejects.toThrow(
      "zigbee2mqtt is moving to another version",
    );
    expect(await host.context.journal.read()).toBeNull();

    holder = null;
    await updates.start("dev-2");
    await updates.wait();

    expect((await host.context.journal.read())?.outcome).toBe("updated");
  });

  it("holds the slot from its first step until its journal has finished", async () => {
    const host = await createHost();
    host.release("dev-2");
    const operations = createOperations();
    const updates = createUpdateService({
      ...host.context,
      operations,
      config,
      onCoreCommitted: async () => {},
    });

    const started = updates.start("dev-2");
    expect(await operations.current()).toEqual({
      kind: "core-update",
      version: "dev-2",
    });
    await started;
    expect(await operations.current()).toEqual({
      kind: "core-update",
      version: "dev-2",
    });

    await updates.wait();

    expect(await operations.current()).toBeNull();
  });

  it("is found holding it by a manager that starts mid-update", async () => {
    const host = await createHost();
    await host.context.journal.save({
      id: "update-1",
      version: "dev-2",
      startedAt: new Date().toISOString(),
      phase: "manager",
      core: { status: "updated", image: image("core", "dev-2") },
      manager: { status: "pending", image: image("manager", "dev-2") },
      log: [],
    });
    const operations = createOperations();
    createUpdateService({
      ...host.context,
      operations,
      config,
      onCoreCommitted: async () => {},
    });

    expect(await operations.current()).toEqual({
      kind: "core-update",
      version: "dev-2",
    });
  });
});

describe("update safety", () => {
  it("leaves an up-to-date core alone if recording the skip fails", async () => {
    const host = await createHost();
    host.docker.alias(image("core", "dev-2"), image("core", "dev-1"));
    host.docker.alias(image("manager", "dev-2"), image("manager", "dev-1"));
    const save = host.context.journal.save;
    let hasFailed = false;
    vi.spyOn(host.context.journal, "save").mockImplementation(
      async (journal) => {
        if (journal.core.status === "skipped" && !hasFailed) {
          hasFailed = true;
          throw new Error("Journal temporarily unavailable");
        }
        await save(journal);
      },
    );
    const before = host.docker.container(coreContainerName)!.id;
    expect((await host.update("dev-2")).outcome).toBe("failed");
    expect(host.docker.container(coreContainerName)?.id).toBe(before);
    expect(host.docker.container(coreContainerName)?.running).toBe(true);
    expect(
      host.docker.events.filter((event) => !event.startsWith("pull")),
    ).toEqual([]);
  });

  it("recognizes and prunes release images when CI replaces their OCI titles", async () => {
    const host = await createHost();
    const stale = host.docker.load(image("core", "dev-0"), {
      title: "sanctum-core",
      version: "dev-0",
    });
    host.release("dev-2");
    for (const entry of host.docker.registry.values()) {
      entry.labels["org.opencontainers.image.title"] = "sanctum";
    }
    const journal = await host.update("dev-2");
    expect(journal.outcome).toBe("updated");
    expect(host.docker.images.has(stale)).toBe(false);
  });

  it("accepts only one of two simultaneous update requests", async () => {
    const host = await createHost();
    host.release("dev-2");
    const requests = await Promise.allSettled([
      host.updates.start("dev-2"),
      host.updates.start("dev-2"),
    ]);
    expect(
      requests.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      requests.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: expect.any(UpdateConflictError) });
    await host.updates.wait();
    expect((await host.context.journal.read())?.outcome).toBe("updated");
  });

  it("waits for an active reconcile before touching containers", async () => {
    const host = await createHost();
    host.release("dev-2");
    let release = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const reconciler = createReconciler({ run, log: () => {}, intervalMs: 0 });
    const reconciling = reconciler.reconcile();
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    const updates = createUpdateService({
      operations: createOperations(),
      ...host.context,
      config,
      onCoreCommitted: async () => {},
      waitForReconcile: reconciler.wait,
    });
    await updates.start("dev-2");
    expect(host.docker.events).toEqual([]);
    release();
    await reconciling;
    await updates.wait();
    expect((await host.context.journal.read())?.outcome).toBe("updated");
  });

  it("does not roll back data when cleanup fails after core commit", async () => {
    const host = await createHost();
    host.release("dev-2");
    vi.spyOn(host.docker, "listImages").mockImplementationOnce(async () => {
      await writeFile(join(host.coreDataDir, "core.db"), "new client writes");
      throw new Error("Docker temporarily unavailable");
    });
    const journal = await host.update("dev-2");
    expect(journal.core.status).toBe("committing");
    expect(
      host.docker.imageOf(coreContainerName)?.labels[
        "org.opencontainers.image.version"
      ],
    ).toBe("dev-2");
    expect(await readFile(join(host.coreDataDir, "core.db"), "utf8")).toBe(
      "new client writes",
    );
    await host.updates.resume();
    expect((await host.context.journal.read())?.outcome).toBe("updated");
    expect(await readFile(join(host.coreDataDir, "core.db"), "utf8")).toBe(
      "new client writes",
    );
  });

  it("does not restore twice after the old core has started serving again", async () => {
    const host = await createHost();
    host.release("dev-2", { core: "unhealthy" });
    const journal = await host.update("dev-2");
    journal.phase = "core";
    journal.core.status = "restored";
    await host.context.journal.save(journal);
    await writeFile(join(host.coreDataDir, "core.db"), "writes after rollback");
    await host.updates.resume();
    expect((await host.context.journal.read())?.outcome).toBe("rolled-back");
    expect(await readFile(join(host.coreDataDir, "core.db"), "utf8")).toBe(
      "writes after rollback",
    );
  });

  it("stops a rebooted old core before restoring its data", async () => {
    const host = await createHost();
    host.release("dev-2", { core: "unhealthy" });
    const journal = await host.update("dev-2");
    journal.phase = "core";
    journal.core.status = "rolling-back";
    await host.context.journal.save(journal);
    host.docker.events = [];
    await host.updates.resume();
    expect(host.docker.events).toEqual([
      `stop ${coreContainerName}`,
      `start ${coreContainerName}`,
    ]);
  });

  it("leaves an unlabelled core untouched during an update", async () => {
    const host = await createHost();
    host.release("dev-2");
    host.docker.container(coreContainerName)!.options.Labels = {};
    const journal = await host.update("dev-2");
    expect(journal.outcome).toBe("failed");
    expect(journal.error).toMatch(/Refusing to manage unlabelled/);
    expect(
      host.docker.events.filter((event) => !event.startsWith("pull")),
    ).toEqual([]);
    expect(host.docker.container(coreContainerName)?.running).toBe(true);
  });

  it("recreates a core with a broken network using its original image", async () => {
    const host = await createHost();
    const original = host.docker.container(coreContainerName)!.imageId;
    host.docker.load(image("core", "dev-1"), {
      title: "sanctum-core",
      version: "rejected",
    });
    host.docker.container(coreContainerName)!.running = false;
    host.docker.startError = new Error("network sandbox not found");
    const resolved = await reconcileCore({
      docker: host.docker,
      image: image("core", "dev-1"),
      log: () => {},
    });
    expect(resolved).toBe(original);
    expect(host.docker.container(coreContainerName)?.imageId).toBe(original);
  });

  it("uses the inspected image even if its tag moves before core creation", async () => {
    const host = await createHost();
    host.release("dev-2");
    const create = host.docker.createContainer.bind(host.docker);
    vi.spyOn(host.docker, "createContainer").mockImplementation(
      async (options) => {
        host.docker.load(image("core", "dev-2"), {
          title: "sanctum-core",
          version: "unexpected",
        });
        return create(options);
      },
    );
    const journal = await host.update("dev-2");
    expect(journal.outcome).toBe("updated");
    expect(host.docker.container(coreContainerName)?.imageId).toBe(
      journal.core.imageId,
    );
    expect(host.committed).toEqual([journal.core.imageId]);
  });

  it("resumes manager commit after cleanup fails without reverting it", async () => {
    const host = await createHost();
    host.release("dev-2", { manager: "healthy" });
    await host.update("dev-2");
    vi.spyOn(host.docker, "listImages").mockRejectedValueOnce(
      new Error("Docker temporarily unavailable"),
    );
    await expect(runUpdater(host.context)).rejects.toThrow(
      "Docker temporarily unavailable",
    );
    expect((await host.context.journal.read())?.manager.status).toBe(
      "committing",
    );
    expect(host.docker.container(previousManagerContainerName)).toBeUndefined();
    expect(
      host.docker.container(updaterContainerName)?.options.HostConfig,
    ).toMatchObject({ RestartPolicy: { Name: "unless-stopped" } });
    await runUpdater(host.context);
    expect((await host.context.journal.read())?.outcome).toBe("updated");
    expect(
      host.docker.imageOf(managerContainerName)?.labels[
        "org.opencontainers.image.version"
      ],
    ).toBe("dev-2");
  });

  it("resumes a manager swap interrupted after stop but before rename", async () => {
    const host = await createHost();
    host.release("dev-2", { manager: "healthy" });
    const journal = await host.update("dev-2");
    journal.manager.status = "swapping";
    await host.context.journal.save(journal);
    await host.docker.getContainer(managerContainerName).stop();
    const getContainer = host.docker.getContainer.bind(host.docker);
    vi.spyOn(host.docker, "getContainer").mockImplementation((id) => {
      const container = getContainer(id);
      return {
        ...container,
        stop: async () => {
          if (!(await container.inspect()).State.Running)
            throw new Error("Container already stopped");
          return container.stop();
        },
      };
    });
    await runUpdater(host.context);
    expect((await host.context.journal.read())?.outcome).toBe("updated");
    expect(host.docker.container(previousCoreContainerName)).toBeUndefined();
  });
});
