import { NotReady } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import * as appLinks from "../src/app-host/link.js";
import { useCleanUps } from "./app-apart-support.js";
import { falls, id, version, type Seen } from "./app-update-fixtures.js";
import {
  committedOf,
  rowOf,
  running,
  stateOf,
  versions,
} from "./app-update-support.js";

// An app's update while the manager's slot is taken: it waits for its turn and
// asks again by itself, whatever of the app still runs meanwhile.

useCleanUps();

function pauseSocket() {
  const createLink = appLinks.createAppLink;
  const hello = vi.fn();
  let link: appLinks.AppLink | undefined;
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const creating = vi
    .spyOn(appLinks, "createAppLink")
    .mockImplementation((options) => {
      link = createLink({
        ...options,
        refuses: () => {
          hello();
          return options.refuses?.();
        },
      });
      const listen = link.listen;
      link.listen = async () => {
        await listen();
        // Socket permissions finish asynchronously before the host records
        // the update. The old container can reconnect during that wait.
        await held;
      };
      return link;
    });
  return {
    hello,
    isConnected: () => link?.isConnected(),
    release() {
      release();
      creating.mockRestore();
    },
  };
}

describe("an update that waits for its turn", () => {
  it("holds the old build back while a same-version update is retried", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    let isReady = false;
    const seen: Seen = [];
    const core = await home.coreWith(
      version("1.0.0", {
        seen,
        start: async () => {
          if (!isReady) throw new NotReady("Waiting for its service");
        },
      }),
      { folder: "1.0.0+rebuilt", retryAfterMs: 1_000 },
    );
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    await running(core, id);
    const socket = pauseSocket();
    isReady = true;
    try {
      await vi.waitFor(() => expect(socket.hello).toHaveBeenCalled(), {
        timeout: 3_000,
      });
      expect(socket.isConnected()).toBe(false);
    } finally {
      socket.release();
    }
    await vi.waitFor(() =>
      expect(committedOf(core)?.folder).toBe("1.0.0+rebuilt"),
    );
    expect(seen).toEqual([
      { reason: "updated", from: "1.0.0" },
      { reason: "updated", from: "1.0.0" },
    ]);
  });

  it("holds a failed build back until the manager can restore its data", async () => {
    const home = await versions();
    const seen: Seen = [];
    await running(await home.coreWith(version("1.0.0", { seen })), id);
    seen.length = 0;
    let isAvailable = false;
    const undo = home.manager.undoAppUpdate;
    home.manager.undoAppUpdate = async (app, update) => {
      if (!isAvailable) throw new Error("The manager is unavailable");
      await undo(app, update);
    };
    const start = vi.fn(falls);

    const core = await home.coreWith(version("1.0.0", { start }), {
      folder: "1.0.0+rebuilt",
    });
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undoing"));
    await vi.waitFor(() =>
      expect(core.logs.join()).toContain("its data hasn't been restored"),
    );
    expect(start).toHaveBeenCalledOnce();
    expect(seen).toEqual([]);

    isAvailable = true;
    await running(core, id);

    expect(seen).toEqual([{ reason: "rolledBack", from: "1.0.0" }]);
    expect(committedOf(core)?.folder).toBe("1.0.0+test");
    expect(rowOf(core)?.status).toBe("undone");
  });

  it("holds the build before back as soon as its socket listens, before recording its update", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const socket = pauseSocket();
    const seen: Seen = [];
    const starting = home.coreWith(version("1.0.0", { seen }), {
      folder: "1.0.0+rebuilt",
    });
    try {
      await vi.waitFor(() => expect(socket.hello).toHaveBeenCalled());
      expect(socket.isConnected()).toBe(false);
    } finally {
      socket.release();
      await starting;
    }
    const core = await starting;
    await running(core, id);
    expect(seen).toEqual([{ reason: "updated", from: "1.0.0" }]);
    expect(committedOf(core)?.folder).toBe("1.0.0+rebuilt");
  });

  it("waits for its turn while the manager's slot is taken, not counting it", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    let busy = true;
    const begin = home.manager.beginAppUpdate;
    home.manager.beginAppUpdate = async (app, request) => {
      if (busy) throw new Error("HTTP 409: An update is already running");
      await begin(app, request);
    };

    const core = await home.coreWith(version("2.0.0"));
    await vi.waitFor(() => expect(stateOf(core, id).state).toBe("waiting"));
    expect(stateOf(core, id).run?.waitingFor).toBe(
      "Waiting for its turn to update",
    );
    expect(stateOf(core, id).run?.failures).toBeUndefined();

    busy = false;
    await running(core, id);

    expect(committedOf(core)?.version).toBe("2.0.0");
  });

  it("asks again for a new build of the same version, though the one before goes on in its container meanwhile", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    let busy = true;
    const begin = home.manager.beginAppUpdate;
    home.manager.beginAppUpdate = async (app, request) => {
      if (busy) throw new Error("HTTP 409: An update is already running");
      await begin(app, request);
    };

    // The build before still runs, and says hello to this core as itself:
    // its version and manifest are the new build's.
    const seen: Seen = [];
    const core = await home.coreWith(version("1.0.0", { seen }), {
      folder: "1.0.0+rebuilt",
    });
    await vi.waitFor(() => expect(stateOf(core, id).state).toBe("waiting"));
    await vi.waitFor(() => expect(core.logs.join()).toContain("was refused"));
    expect(stateOf(core, id).state).toBe("waiting");
    expect(home.containers).toEqual(["1.0.0+test"]);

    busy = false;
    await running(core, id);

    expect(home.containers).toEqual(["1.0.0+test", "1.0.0+rebuilt"]);
    expect(seen).toEqual([{ reason: "updated", from: "1.0.0" }]);
    expect(committedOf(core)?.folder).toBe("1.0.0+rebuilt");
  });
});
