import { describe, expect, it } from "vitest";

import { coreContainerName } from "../src/core-container.js";
import {
  managerContainerName,
  previousManagerContainerName,
  runUpdater,
  updaterContainerName,
} from "../src/update/manager-update.js";
import { UpdateConflictError } from "../src/update/service.js";
import { createHost } from "./host.js";

describe("interrupted update ownership", () => {
  it("does not start an unlabelled manager occupying the replacement name", async () => {
    const host = await createHost();
    host.release("dev-2", { manager: "healthy" });
    const journal = await host.update("dev-2");
    await host.docker.getContainer(managerContainerName).stop();
    await host.docker.getContainer(managerContainerName).rename({
      name: previousManagerContainerName,
    });
    const foreign = await host.docker.createContainer({
      name: managerContainerName,
      Image: journal.manager.imageId!,
    });
    journal.manager.status = "swapping";
    await host.context.journal.save(journal);
    host.docker.events = [];

    await expect(runUpdater(host.context)).rejects.toThrow(/unlabelled/);

    expect(host.docker.events).toEqual([]);
    expect(host.docker.container(managerContainerName)).toMatchObject({
      id: foreign.id,
      running: false,
    });
    expect(host.docker.container(previousManagerContainerName)?.id).toBe(
      journal.manager.previousContainerId,
    );
  });

  it("does not start a replacement for the core after its data was restored", async () => {
    const host = await createHost();
    host.release("dev-2", { core: "crash" });
    const journal = await host.update("dev-2");
    const image = host.docker.container(coreContainerName)!.imageId;
    await host.docker.getContainer(coreContainerName).remove();
    await host.docker.createContainer({
      name: coreContainerName,
      Image: image,
    });
    journal.phase = "core";
    journal.core.status = "restored";
    await host.context.journal.save(journal);
    host.docker.events = [];

    await expect(host.updates.resume()).rejects.toThrow(/unlabelled/);

    expect(host.docker.events).toEqual([]);
    expect(host.docker.container(coreContainerName)?.running).toBe(false);
    expect(await host.updates.busy()).toBe(true);
  });

  it("does not start an unlabelled manager when resuming rollback", async () => {
    const host = await createHost();
    host.release("dev-2", { manager: "healthy" });
    const journal = await host.update("dev-2");
    await host.docker.getContainer(managerContainerName).remove();
    await host.docker.createContainer({
      name: managerContainerName,
      Image: journal.manager.fromImageId!,
    });
    journal.manager.status = "rolling-back";
    await host.context.journal.save(journal);
    host.docker.events = [];

    await expect(runUpdater(host.context)).rejects.toThrow(/unlabelled/);

    expect(host.docker.events).toEqual([]);
    expect(host.docker.container(managerContainerName)?.running).toBe(false);
  });
});

describe("exhausted updater recovery", () => {
  it.each(["checking", "committing", "rolling-back"] as const)(
    "keeps the recovery record and blocks new updates during %s",
    async (status) => {
      const host = await createHost();
      host.release("dev-2", { manager: "healthy" });
      const journal = await host.update("dev-2");
      await host.docker.getContainer(updaterContainerName).stop();
      journal.manager.status = status;
      journal.manager.attempts = 3;
      await host.context.journal.save(journal);

      await expect(host.updates.resume()).rejects.toThrow(/recovery attempts/);

      expect(await host.context.journal.read()).toEqual(journal);
      expect(await host.updates.busy()).toBe(true);
      await expect(host.updates.start("dev-3")).rejects.toThrow(
        UpdateConflictError,
      );
    },
  );
});
