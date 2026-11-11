import { describe, expect, it } from "vitest";

import {
  managerContainerName,
  previousManagerContainerName,
  resumeManager,
  runUpdater,
  updaterContainerName,
} from "../src/update/manager-update.js";
import { createHost } from "./host.js";

async function handOver(manager: "healthy" | "unhealthy" | "crash") {
  const host = await createHost();
  host.release("dev-2", { manager });
  const before = host.docker.container(managerContainerName)!;
  const journal = await host.update("dev-2");
  return { ...host, before, journal };
}

describe("manager update", () => {
  it("hands over to an updater started from the new image", async () => {
    const { docker, journal, before } = await handOver("healthy");

    expect(journal).toMatchObject({
      phase: "manager",
      core: { status: "updated" },
      manager: {
        status: "pending",
        previousContainerId: before.id,
        fromVersion: "dev-1",
        version: "dev-2",
      },
    });
    const updater = docker.container(updaterContainerName)!;
    expect(updater.running).toBe(true);
    expect(updater.imageId).toBe(journal.manager.imageId);
    expect(updater.options).toMatchObject({
      Cmd: ["node", "dist/updater.js"],
      Env: ["SANCTUM_CHANNEL=dev"],
      Labels: { "sanctum.role": "manager-updater" },
      HostConfig: {
        NetworkMode: "host",
        Binds: before.options.HostConfig?.Binds,
        RestartPolicy: { Name: "unless-stopped" },
      },
    });
    // The old manager keeps running until the updater swaps it.
    expect(docker.container(managerContainerName)?.id).toBe(before.id);
  });

  it("swaps the manager and commits once the new one is healthy", async () => {
    const host = await handOver("healthy");

    await runUpdater(host.context);

    const journal = (await host.context.journal.read())!;
    expect(journal).toMatchObject({
      phase: "done",
      outcome: "updated",
      manager: { status: "updated" },
    });
    const manager = host.docker.container(managerContainerName)!;
    expect(manager.id).not.toBe(host.before.id);
    expect(manager.running).toBe(true);
    expect(host.docker.imageOf(managerContainerName)?.labels).toMatchObject({
      "org.opencontainers.image.version": "dev-2",
    });
    // Compose's settings carry over; the old image's own values do not.
    expect(manager.ref).toBe(journal.manager.imageId);
    expect(manager.options.Env).toEqual(["SANCTUM_CHANNEL=dev"]);
    expect(manager.options.Labels).toEqual({
      "com.docker.compose.project": "sanctum",
      "com.docker.compose.service": "manager",
    });
    expect(manager.options.Cmd).toBeUndefined();
    expect(manager.options.HostConfig).toMatchObject({
      NetworkMode: "host",
      RestartPolicy: { Name: "unless-stopped" },
    });
    expect(host.docker.container(previousManagerContainerName)).toBeUndefined();
    expect(
      host.docker.container(updaterContainerName)?.options.HostConfig,
    ).toMatchObject({ RestartPolicy: { Name: "no" } });
  });

  it.each(["unhealthy", "crash"] as const)(
    "puts the previous manager back when the new one is %s",
    async (behaviour) => {
      const host = await handOver(behaviour);

      await runUpdater(host.context);

      const journal = (await host.context.journal.read())!;
      expect(journal).toMatchObject({
        phase: "done",
        outcome: "rolled-back",
        manager: { status: "rolled-back" },
      });
      const manager = host.docker.container(managerContainerName)!;
      expect(manager.id).toBe(host.before.id);
      expect(manager.running).toBe(true);
      expect(
        host.docker.container(previousManagerContainerName),
      ).toBeUndefined();
    },
  );

  it("picks up a swap where a lost updater stopped", async () => {
    const host = await handOver("healthy");
    // The updater died right after stopping and renaming the old manager.
    await host.docker.getContainer(managerContainerName).stop();
    await host.docker.getContainer(managerContainerName).rename({
      name: previousManagerContainerName,
    });
    const journal = (await host.context.journal.read())!;
    await host.context.journal.save({
      ...journal,
      manager: { ...journal.manager, status: "swapping" },
    });

    await runUpdater(host.context);

    expect((await host.context.journal.read())?.outcome).toBe("updated");
    expect(host.docker.imageOf(managerContainerName)?.labels).toMatchObject({
      "org.opencontainers.image.version": "dev-2",
    });
  });
});

describe("resuming a manager update", () => {
  it("leaves a running updater alone", async () => {
    const host = await handOver("healthy");
    const journal = (await host.context.journal.read())!;

    await resumeManager(host.context, journal);

    expect((await host.context.journal.read())?.manager.attempts).toBe(1);
  });

  it("restarts an updater a reboot stopped mid-swap", async () => {
    const host = await handOver("healthy");
    await host.docker.getContainer(updaterContainerName).stop();
    const journal = (await host.context.journal.read())!;
    journal.manager.status = "checking";
    await host.context.journal.save(journal);

    await resumeManager(host.context, journal);

    expect((await host.context.journal.read())?.manager.attempts).toBe(2);
    expect(host.docker.container(updaterContainerName)?.running).toBe(true);
  });

  it("gives up an update whose updater never began", async () => {
    const host = await handOver("healthy");
    await host.docker.getContainer(updaterContainerName).stop();
    const journal = (await host.context.journal.read())!;

    await resumeManager(host.context, journal);

    expect(await host.context.journal.read()).toMatchObject({
      phase: "done",
      outcome: "failed",
    });
    expect(host.docker.container(managerContainerName)?.id).toBe(
      host.before.id,
    );
  });
});
