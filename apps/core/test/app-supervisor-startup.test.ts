import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstalledApp } from "../src/app-host/installed.js";
import { ManagerUnavailable } from "../src/manager.js";
import { manifest, passes, setUp } from "./app-supervisor-support.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("an app's supervised startup", () => {
  it("asks for its container, by its running version and limits", async () => {
    const startAppContainer = vi.fn(async () => ({ kept: false }));
    const { entry, supervisor, phase } = setUp({ startAppContainer });

    await supervisor.launch(entry);

    expect(startAppContainer).toHaveBeenCalledWith(manifest.id, {
      folder: "1.0.0+test",
      memoryMb: 128,
      dataMb: 256,
      keep: true,
    });
    expect(phase()).toBe("starting");
  });

  it("keeps one that asks for a range of ports, switched on or not, waiting for a manager that takes ranges", async () => {
    let ranges = false;
    const { entry, supervisor, started, stopped, phase } = setUp(
      {
        capabilities: () => ({
          appContainers: true,
          memoryLimits: true,
          discovery: true,
          lan: true,
          portRanges: ranges,
          deletesData: false,
          reserves: false,
        }),
      },
      {
        starting: () => ({
          core: "core",
          count: 1,
          addresses: [],
          ports: [6053],
        }),
        started: () => true,
        canRun: () => true,
      },
    );
    entry.manifest = {
      ...manifest,
      permissions: [{ id: "lan:tcp:6053" }, { id: "lan:tcp:49152-65535" }],
    } as typeof manifest;
    // Only the single port is on: switching the range on later mustn't
    // find a manager that refuses it.
    entry.granted = ["lan:tcp:6053"];

    await supervisor.launch(entry);
    await passes(60_000);

    expect(phase()).toBe("waiting");
    expect(entry.supervision!.waitingFor).toBe(
      "Waiting for an update that lets it reach your devices",
    );
    expect(started).toEqual([]);
    expect(stopped).toEqual([entry.app.id]);

    // Asked again after its next pause.
    ranges = true;
    await passes(300_000);
    expect(started).toContain(entry.app.id);
    supervisor.end(entry);
  });

  it("keeps a running container only for its first start, not once it has failed", async () => {
    const startAppContainer = vi.fn(async () => ({ kept: true }));
    const { entry, supervisor } = setUp({ startAppContainer });
    await supervisor.launch(entry);

    supervisor.startFailed(entry);
    await passes(1_000);

    expect(startAppContainer).toHaveBeenCalledTimes(2);
    expect(startAppContainer.mock.calls[1]).toEqual([
      manifest.id,
      { folder: "1.0.0+test", memoryMb: 128, dataMb: 256 },
    ]);
  });

  it("starts it once its connection is ready, and it runs once its start returns", async () => {
    const { entry, supervisor, reconciled, phase } = setUp();
    await supervisor.launch(entry);

    supervisor.ready(entry);
    expect(reconciled).toHaveBeenCalledWith(entry);
    expect(phase()).toBe("starting");

    supervisor.started(entry);
    expect(phase()).toBe("running");
  });

  it("counts a container that doesn't say hello in time as a failed start", async () => {
    const { entry, supervisor, phase } = setUp();
    await supervisor.launch(entry);

    await passes(60_000);

    expect(phase()).toBe("restarting");
    expect(entry.supervision!.lastFailure).toBe("failed_start");
  });

  // A new process loads its code from a disk that writes out a backlog
  // first, as after a large pull on an SD card.
  it("waits on for hello while the host writes out, up to three minutes more, and says so once", async () => {
    let writing = true;
    const { entry, supervisor, phase, logs } = setUp({
      writingOut: () => writing,
    });
    await supervisor.launch(entry);

    await passes(60_000 + 2 * 60_000);
    expect(phase()).toBe("starting");
    expect(
      logs.filter((line) => line.includes("hasn't said hello while the host")),
    ).toHaveLength(1);

    await passes(60_000);
    expect(phase()).toBe("restarting");
    expect(entry.supervision!.lastFailure).toBe("failed_start");
    expect(logs).toContain(`apps: ${manifest.id} didn't say hello in time`);
    writing = false;
  });

  it("stops waiting for hello once the host is done writing out", async () => {
    let writing = true;
    const { entry, supervisor, phase } = setUp({ writingOut: () => writing });
    await supervisor.launch(entry);
    await passes(90_000);
    expect(phase()).toBe("starting");

    writing = false;
    await passes(1_000);

    expect(phase()).toBe("restarting");
    expect(entry.supervision!.lastFailure).toBe("failed_start");
  });

  it.each([-3_600_000, 3_600_000])(
    "keeps the minute's deadline when the system clock moves by %s ms",
    async (offset) => {
      const { entry, supervisor, phase } = setUp();
      await supervisor.launch(entry);

      vi.setSystemTime(Date.now() + offset);
      await passes(1_000);
      expect(phase()).toBe("starting");
      await passes(58_999);
      expect(phase()).toBe("starting");
      await passes(1);
      expect(phase()).toBe("restarting");
      expect(entry.supervision!.lastFailure).toBe("failed_start");
    },
  );

  it("counts one whose container stops before hello as a failed start within a second", async () => {
    let state: "running" | "stopped" = "running";
    const { entry, supervisor, phase } = setUp({
      appContainer: async () => ({ state }),
    });
    await supervisor.launch(entry);
    await passes(5_000);
    expect(phase()).toBe("starting");

    state = "stopped";
    await passes(1_000);

    expect(phase()).toBe("restarting");
    expect(entry.supervision!.lastFailure).toBe("failed_start");
    expect(entry.supervision!.failures).toHaveLength(1);
  });

  it("says one ran out of memory before hello when the kernel says so", async () => {
    const { entry, supervisor } = setUp({
      appContainer: async () => ({ state: "stopped", outOfMemory: true }),
    });
    await supervisor.launch(entry);
    await passes(1_000);

    expect(entry.supervision!.lastFailure).toBe("out_of_memory");
  });

  it("stops checking once an update takes over a failed start's rollback", async () => {
    const appContainer = vi.fn(async () => ({ state: "stopped" as const }));
    const { entry, supervisor, stopped, updateFailed } = setUp({
      appContainer,
    });
    updateFailed.mockReturnValue(true);
    await supervisor.launch(entry);

    await passes(1_000);
    expect(updateFailed).toHaveBeenCalledExactlyOnceWith(entry, "failed_start");
    expect(entry.supervision!.timer).toBeUndefined();
    await passes(120_000);
    expect(appContainer).toHaveBeenCalledTimes(1);
    expect(updateFailed).toHaveBeenCalledTimes(1);
    expect(entry.supervision!.failures).toEqual([]);
    expect(stopped).toEqual([]);
  });

  it("still waits out the minute when the manager doesn't say", async () => {
    const { entry, supervisor, phase } = setUp({
      appContainer: async () => {
        throw new ManagerUnavailable("The manager did not answer");
      },
    });
    await supervisor.launch(entry);

    await passes(59_999);
    expect(phase()).toBe("starting");
    await passes(1);
    expect(phase()).toBe("restarting");
    expect(entry.supervision!.lastFailure).toBe("failed_start");
  });

  it.each(["running", "stopped"] as const)(
    "keeps the minute's deadline while a status request is pending (late answer: %s)",
    async (state) => {
      let answer!: (status: { state: "running" | "stopped" }) => void;
      const appContainer = vi.fn(
        async (): Promise<{
          state: "running" | "stopped";
        }> => ({ state: "running" }),
      );
      const { entry, supervisor, started, phase } = setUp({ appContainer });
      await supervisor.launch(entry);
      await passes(58_000);
      appContainer.mockImplementationOnce(
        () => new Promise((resolve) => (answer = resolve)),
      );

      await passes(1_999);
      expect(phase()).toBe("starting");
      await passes(1);

      expect(phase()).toBe("restarting");
      expect(entry.supervision!.lastFailure).toBe("failed_start");
      const restartTimer = entry.supervision!.timer;
      answer({ state });
      await passes(0);
      expect(entry.supervision!.failures).toHaveLength(1);
      expect(entry.supervision!.timer).toBe(restartTimer);
      await passes(1_000);
      expect(started).toEqual([manifest.id, manifest.id]);
      expect(phase()).toBe("starting");
    },
  );

  it("keeps one status request in flight and still fails at the deadline", async () => {
    const appContainer = vi.fn(
      () => new Promise<{ state: "running" }>(() => undefined),
    );
    const { entry, supervisor, phase } = setUp({ appContainer });
    await supervisor.launch(entry);

    await passes(59_999);
    expect(appContainer).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("starting");
    await passes(1);
    expect(phase()).toBe("restarting");
    expect(entry.supervision!.lastFailure).toBe("failed_start");
  });

  it("leaves one that says hello as the manager answers to its connection", async () => {
    let answer!: (status: { state: "stopped" }) => void;
    const { entry, supervisor, phase } = setUp({
      appContainer: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    await supervisor.launch(entry);
    await passes(1_000);

    entry.link = {
      isReady: () => false,
      isConnected: () => true,
    } as InstalledApp["link"];
    answer({ state: "stopped" });
    await passes(60_000);

    expect(phase()).toBe("starting");
    expect(entry.supervision!.failures).toEqual([]);
  });

  it("doesn't count it once it has said hello", async () => {
    const { entry, supervisor, phase } = setUp();
    await supervisor.launch(entry);
    supervisor.ready(entry);

    await passes(120_000);

    expect(phase()).toBe("starting");
  });

  it("lets a connected app finish preparing within the socket's own deadline", async () => {
    const { entry, supervisor, phase } = setUp();
    await supervisor.launch(entry);
    entry.link = {
      isReady: () => false,
      isConnected: () => true,
    } as InstalledApp["link"];

    await passes(60_000);

    expect(phase()).toBe("starting");
    expect(entry.supervision!.failures).toEqual([]);
  });
});
