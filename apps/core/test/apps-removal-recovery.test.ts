import { defineApp } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { createAppRemoving } from "../src/app-host/removing.js";
import { createListTurns } from "../src/app-host/list-turns.js";
import { apart, base, running, useCleanUps } from "./app-apart-support.js";
import { fakeManager } from "./manager-support.js";
import { claimed, post, testCore } from "./support.js";

useCleanUps();

describe("finishing an app's removal", () => {
  it("keeps an installed app's failed container cleanup for recovery", async () => {
    const { manager } = fakeManager();
    const app = defineApp({
      ...base,
      id: "sanctum.example",
      permissions: [],
      actions: [],
    });
    const { core } = await apart(app, { manager });
    await running(core, app.id);
    const maya = await claimed(core);
    manager.removeAppContainer = vi.fn(async () => {
      throw new Error("manager unavailable");
    });

    const response = await post(core, `/api/apps/${app.id}/remove`, {}, maya);

    // It's removed: what's left is done again at the next start.
    expect(response.statusCode).toBe(200);
    expect(core.apps.has(app.id)).toBe(false);
    expect(core.removedApps.get(app.id)?.isDone).toBe(false);
    manager.removeAppContainer = vi.fn(async () => undefined);
    await core.appRemoving.resume();
    expect(core.removedApps.get(app.id)?.isDone).toBe(true);
  });

  it("takes what it brought and its container even when stopping it fails", async () => {
    const { manager } = fakeManager();
    const app = defineApp({
      ...base,
      id: "sanctum.example",
      permissions: [],
      actions: [],
      stop: async () => {
        throw new Error("won't stop");
      },
    });
    const { core } = await apart(app, { manager });
    await running(core, app.id);
    const maya = await claimed(core);
    const removeAppContainer = vi.spyOn(manager, "removeAppContainer");

    const response = await post(core, `/api/apps/${app.id}/remove`, {}, maya);

    expect(response.statusCode).toBe(200);
    expect(removeAppContainer).toHaveBeenCalledWith(app.id);
    expect(core.removedApps.get(app.id)?.isDone).toBe(true);
  });

  it.each(["container", "lookup", "release"])(
    "keeps the removal unfinished after a failed %s, then retries it",
    async (failure) => {
      const core = await testCore();
      const removeAppContainer = vi.fn(async () => {
        if (failure === "container") throw new Error("manager unavailable");
      });
      const servicesHeldBy = vi.fn(async () => {
        if (failure === "lookup") throw new Error("manager unavailable");
        return ["mosquitto"];
      });
      const releaseService = vi.fn(async () => {
        if (failure === "release") throw new Error("manager unavailable");
      });
      const removing = createAppRemoving({
        gate: core.gate,
        turns: createListTurns(),
        host: core.apps,
        removed: core.removedApps,
        updates: { shownFor: () => undefined },
        workflows: () => core.workflows.forApps,
        devices: core.devices,
        entities: core.entities,
        activity: core.activity,
        manager: { removeAppContainer, servicesHeldBy, releaseService },
        log: () => undefined,
      });
      core.removedApps.record(
        "sanctum.example",
        {},
        { name: "Example", version: "1.0.0" },
      );

      const removeApp = vi.spyOn(core.entities, "removeApp");
      await removing.resume();

      expect(core.removedApps.get("sanctum.example")?.isDone).toBe(false);
      // What it brought goes, though the app isn't installed any more.
      expect(removeApp).toHaveBeenCalledWith("sanctum.example");
      removeAppContainer.mockResolvedValue(undefined);
      servicesHeldBy.mockResolvedValue(["mosquitto"]);
      releaseService.mockResolvedValue(undefined);

      await removing.resume();

      expect(core.removedApps.get("sanctum.example")?.isDone).toBe(true);
      expect(releaseService).toHaveBeenLastCalledWith(
        "mosquitto",
        "sanctum.example",
        expect.anything(),
      );
    },
  );

  it("lets go of a service the manager still keeps for a removed app", async () => {
    const core = await testCore();
    const releaseService = vi.fn(async () => undefined);
    const removing = createAppRemoving({
      gate: core.gate,
      turns: createListTurns(),
      host: core.apps,
      removed: core.removedApps,
      updates: { shownFor: () => undefined },
      workflows: () => core.workflows.forApps,
      devices: core.devices,
      entities: core.entities,
      activity: core.activity,
      manager: {
        removeAppContainer: async () => undefined,
        // A request from a core that stopped, which landed after the
        // removal finished.
        servicesHeldBy: async () => ["mosquitto"],
        releaseService,
      },
      log: () => undefined,
    });
    core.removedApps.record(
      "sanctum.example",
      {},
      { name: "Example", version: "1.0.0" },
    );
    core.removedApps.done("sanctum.example");

    await removing.releaseLeftover("sanctum.example");

    expect(releaseService).toHaveBeenCalledWith(
      "mosquitto",
      "sanctum.example",
      expect.anything(),
    );
    expect(core.removedApps.get("sanctum.example")?.isDone).toBe(true);
  });

  it("gives up on a manager that doesn't answer, so adding and removing go on", async () => {
    const core = await testCore();
    const turns = createListTurns();
    let signal: AbortSignal | undefined;
    // A release the manager never confirms, until it's given up on.
    const releaseService = vi.fn(
      (_service: string, _app: string, options?: { signal?: AbortSignal }) =>
        new Promise<void>((_, reject) => {
          signal = options?.signal;
          signal?.addEventListener("abort", () =>
            reject(new Error("The manager did not answer in time")),
          );
        }),
    );
    const removing = createAppRemoving({
      gate: core.gate,
      turns,
      host: core.apps,
      removed: core.removedApps,
      updates: { shownFor: () => undefined },
      workflows: () => core.workflows.forApps,
      devices: core.devices,
      entities: core.entities,
      activity: core.activity,
      manager: {
        removeAppContainer: async () => undefined,
        servicesHeldBy: async () => ["mosquitto"],
        releaseService,
      },
      finishWithinMs: 50,
      log: () => undefined,
    });
    core.removedApps.record(
      "sanctum.example",
      {},
      { name: "Example", version: "1.0.0" },
    );

    await removing.resume();

    expect(signal?.aborted).toBe(true);
    expect(core.removedApps.get("sanctum.example")?.isDone).toBe(false);
    // The list's turn is free again.
    await expect(turns.take(async () => "next")).resolves.toBe("next");
  });

  it("gives up waiting on an installed app's removal past the limit", async () => {
    const { manager } = fakeManager();
    const app = defineApp({
      ...base,
      id: "sanctum.example",
      permissions: [],
      actions: [],
    });
    const { core } = await apart(app, { manager });
    await running(core, app.id);
    let finish!: () => void;
    manager.removeAppContainer = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const removing = createAppRemoving({
      gate: core.gate,
      turns: createListTurns(),
      host: core.apps,
      removed: core.removedApps,
      updates: { shownFor: () => undefined },
      workflows: () => core.workflows.forApps,
      devices: core.devices,
      entities: core.entities,
      activity: core.activity,
      manager,
      finishWithinMs: 50,
      log: () => undefined,
    });
    core.removedApps.record(app.id, {}, { name: "Example", version: "1.0.0" });

    await expect(removing.finish(app.id)).rejects.toThrow();

    expect(core.removedApps.get(app.id)?.isDone).toBe(false);
    finish();
  });

  it("finishes a removal already under way before closing its database", async () => {
    const { manager } = fakeManager();
    const core = await testCore({ manager });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    manager.removeAppContainer = vi.fn(() => held);
    core.removedApps.record(
      "sanctum.example",
      {},
      { name: "Example", version: "1.0.0" },
    );
    const done = vi.spyOn(core.removedApps, "done");
    const resuming = core.appRemoving.resume();
    await vi.waitFor(() =>
      expect(manager.removeAppContainer).toHaveBeenCalled(),
    );
    let hasStopped = false;
    const stopping = core.stop().then(() => {
      hasStopped = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(hasStopped).toBe(false);
    } finally {
      release();
      await resuming;
      await stopping;
    }
    expect(done).toHaveReturnedWith(undefined);
    expect(
      core.logs.some((line) => line.includes("removal didn't finish")),
    ).toBe(false);
  });
});
