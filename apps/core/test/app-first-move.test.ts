import { NotReady } from "@meetsanctum/app-sdk";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { useCleanUps } from "./app-apart-support.js";
import { createAppsOff } from "../src/app-host/off.js";
import { appUpdates } from "../src/app-host/schema.js";
import { ManagerRefusal } from "../src/manager.js";
import { falls, id, version, type Seen } from "./app-update-fixtures.js";
import { claimed, get, post, type TestCore } from "./support.js";
import {
  committedOf,
  rowOf,
  running,
  stateOf,
  versions,
} from "./app-update-support.js";

// An app's first move from a core that ran it in its own process to its own
// container, with its file. Its commit says it has moved. Until then its
// original is as it was, and with nowhere else to carry on, a version that fails
// is any app's failure, going on from the copy it took in.

useCleanUps();

const original = (core: TestCore) => join(core.dataDir, "apps", `${id}.db`);

// A home from a release whose core ran the app in its own process, with its file.
async function onTodaysRelease() {
  const home = await versions();
  const core = await home.ranInTheCore(version("1.0.0"));
  home.calls.length = 0;
  return { home, core };
}

describe("a first move that works", () => {
  it("takes in its file, starts apart, and says so once it has committed", async () => {
    const { home } = await onTodaysRelease();
    const asked = vi.spyOn(home.manager, "beginAppUpdate");
    const seen: Seen = [];

    const core = await home.coreWith(version("1.0.0", { seen }));
    await running(core, id);

    expect(asked.mock.calls[0]?.[1]).toMatchObject({
      from: { version: "1.0.0" },
      to: { version: "1.0.0", folder: "1.0.0+test" },
      file: "app.db",
      moves: `${id}.db`,
      dataMb: expect.any(Number),
    });
    expect(asked.mock.calls[0]?.[1].from).not.toHaveProperty("folder");
    expect(seen).toEqual([{ reason: "updated", from: "1.0.0" }]);
    expect(committedOf(core)?.folder).toBe("1.0.0+test");
    expect(rowOf(core)).toBeUndefined();
    await vi.waitFor(() => expect(home.calls).toContain(`COMMIT ${id}`));
  });

  it("says it's updating while it does", async () => {
    const { home } = await onTodaysRelease();
    let finish!: () => void;
    const held = new Promise<void>((done) => {
      finish = done;
    });

    const core = await home.coreWith(
      version("1.0.0", { start: async () => held }),
    );
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("starting"));

    expect(stateOf(core, id).run?.update).toEqual({
      stage: "updating",
      to: "1.0.0",
    });
    finish();
    await running(core, id);
  });

  it("offers nothing to go back to, as nothing ran apart before", async () => {
    const { home } = await onTodaysRelease();
    const core = await home.coreWith(version("1.0.0"));
    await running(core, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    const { token } = await claimed(core);

    const answer = await get(core, `/api/apps/${id}/go-back`, { token });

    expect(answer.json()).toEqual({ to: null });
  });

  it("leaves its original until its next update has committed", async () => {
    const { home } = await onTodaysRelease();
    const moved = await home.coreWith(version("1.0.0"));
    await running(moved, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    mkdirSync(join(moved.dataDir, "apps"), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      writeFileSync(`${original(moved)}${suffix}`, "as it was");
    }
    expect(existsSync(original(moved))).toBe(true);

    const next = await home.coreWith(version("2.0.0"));
    await running(next, id);

    await vi.waitFor(() => {
      expect(existsSync(original(next))).toBe(false);
      expect(existsSync(`${original(next)}-wal`)).toBe(false);
      expect(existsSync(`${original(next)}-shm`)).toBe(false);
    });
  });

  it("waits until someone turns on one that's off", async () => {
    const { home, core: before } = await onTodaysRelease();
    // As someone left it on that release.
    createAppsOff(before.db, { now: () => new Date() }).set(id, true);

    const core = await home.coreWith(version("1.0.0"));
    const { token } = await claimed(core);
    await new Promise((done) => setTimeout(done, 30));
    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toEqual([]);

    await post(core, `/api/apps/${id}/off`, { off: false }, { token });
    await running(core, id);

    expect(committedOf(core)?.folder).toBe("1.0.0+test");
  });
});

describe("a first move that doesn't work", () => {
  it("fails as any app does, going on from the copy, and has moved only once it commits", async () => {
    const { home } = await onTodaysRelease();
    let fails = true;
    const core = await home.coreWith(
      version("1.0.0", {
        start: async () => {
          if (fails) throw new Error("It fell over");
        },
      }),
    );
    await vi.waitFor(() => expect(stateOf(core, id).state).toBe("failed"));

    expect(committedOf(core)?.folder).toBeNull();
    expect(rowOf(core)?.status).toBe("starting");
    expect(home.calls.filter((each) => each.startsWith("UNDO"))).toEqual([]);

    fails = false;
    const { token } = await claimed(core);
    await post(core, `/api/apps/${id}/restart`, {}, { token });
    await running(core, id);

    expect(committedOf(core)?.folder).toBe("1.0.0+test");
    expect(rowOf(core)).toBeUndefined();
    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toHaveLength(
      1,
    );
    await vi.waitFor(() => expect(home.calls).toContain(`COMMIT ${id}`));
  });

  it("tries again from the start when another version arrives", async () => {
    const { home } = await onTodaysRelease();
    const first = await home.coreWith(version("1.0.0", { start: falls }));
    await vi.waitFor(() => expect(stateOf(first, id).state).toBe("failed"));

    const core = await home.coreWith(version("1.1.0"));
    await running(core, id);

    expect(committedOf(core)?.folder).toBe("1.1.0+test");
    expect(rowOf(core)).toBeUndefined();
    expect(home.calls).toContain(`BEGIN ${id} 1.0.0 1.1.0`);
  });

  it("waits, as any app does, while it isn't ready", async () => {
    const { home } = await onTodaysRelease();
    let isReady = false;
    const core = await home.coreWith(
      version("1.0.0", {
        start: async () => {
          if (!isReady) throw new NotReady("Waiting for the test");
        },
      }),
    );
    await vi.waitFor(() => expect(stateOf(core, id).state).toBe("waiting"));
    expect(rowOf(core)?.status).toBe("starting");
    expect(committedOf(core)?.folder).toBeNull();

    isReady = true;
    await running(core, id);
    expect(committedOf(core)?.folder).toBe("1.0.0+test");
  });

  it("waits for its turn while the slot is taken", async () => {
    const { home } = await onTodaysRelease();
    const begin = home.manager.beginAppUpdate;
    let taken = true;
    home.manager.beginAppUpdate = async (app, request) => {
      if (taken) throw new ManagerRefusal("Something else is running", 409);
      await begin(app, request);
    };

    const core = await home.coreWith(version("1.0.0"));
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("waiting"));
    taken = false;
    await running(core, id);

    expect(committedOf(core)?.folder).toBe("1.0.0+test");
  });

  it("waits, rather than give up, while the manager refuses", async () => {
    const { home } = await onTodaysRelease();
    const begin = home.manager.beginAppUpdate;
    let refuses = true;
    home.manager.beginAppUpdate = async (app, request) => {
      if (refuses) throw new ManagerRefusal("It can't be done", 400);
      await begin(app, request);
    };

    const core = await home.coreWith(version("1.0.0"));
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("waiting"));
    core.advance(10 * 60_000);
    await new Promise((done) => setTimeout(done, 20));
    expect(rowOf(core)?.status).toBe("waiting");

    refuses = false;
    await running(core, id);
    expect(committedOf(core)?.folder).toBe("1.0.0+test");
  });

  it("starts afresh after a move a core that ran it in its own process went back from", async () => {
    const { home, core: before } = await onTodaysRelease();
    before.db
      .insert(appUpdates)
      .values({
        appId: id,
        id: "an-earlier-move",
        fromVersion: "1.0.0",
        fromFolder: "",
        toVersion: "1.0.0",
        toFolder: "1.0.0+test",
        status: "undone",
        settings: {},
        failure: "failed_start",
        retryAt: null,
        restores: null,
        chosen: false,
        startedAt: new Date(),
      })
      .run();

    const core = await home.coreWith(version("1.0.0"));
    await running(core, id);

    expect(home.calls).toContain(`BEGIN ${id} 1.0.0 1.0.0`);
    expect(committedOf(core)?.folder).toBe("1.0.0+test");
    expect(rowOf(core)).toBeUndefined();
  });

  it("starts apart with nothing to take in, for an app that never ran before", async () => {
    const home = await versions();

    const core = await home.coreWith(version("1.0.0"));
    await running(core, id);

    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toEqual([]);
  });
});

describe("a power cut in a first move", () => {
  const cutAt = async (status: "waiting" | "starting") => {
    const { home } = await onTodaysRelease();
    let holds = true;
    const moving = version("1.0.0", {
      start: async () => {
        if (holds) await new Promise(() => undefined);
      },
    });
    const core = await home.coreWith(moving);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("starting"));
    if (status === "waiting") {
      core.db.update(appUpdates).set({ status }).run();
    }
    await home.powerCut(core);
    holds = false;
    home.calls.length = 0;
    return { home, moving };
  };

  it("before it started just carries on", async () => {
    const { home, moving } = await cutAt("waiting");

    const core = await home.coreWith(moving);
    await running(core, id);

    expect(committedOf(core)?.folder).toBe("1.0.0+test");
  });

  it("after it started goes on from the copy, not taking it in again", async () => {
    const { home, moving } = await cutAt("starting");

    const core = await home.coreWith(moving);
    await running(core, id);

    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toEqual([]);
    expect(home.calls.filter((each) => each.startsWith("UNDO"))).toEqual([]);
    expect(committedOf(core)?.folder).toBe("1.0.0+test");
  });

  it("gives way to another version that arrived meanwhile", async () => {
    const { home } = await cutAt("starting");

    const core = await home.coreWith(version("1.1.0"));
    await running(core, id);

    expect(committedOf(core)?.version).toBe("1.1.0");
  });
});

describe("once it has moved", () => {
  const moved = async () => {
    const { home } = await onTodaysRelease();
    const core = await home.coreWith(version("1.0.0"));
    await running(core, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    home.calls.length = 0;
    return { home };
  };

  it("doesn't move again", async () => {
    const { home } = await moved();

    const core = await home.coreWith(version("1.0.0"));
    await running(core, id);

    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toEqual([]);
  });

  it("is undone as any update after that", async () => {
    const { home } = await moved();

    const core = await home.coreWith(version("2.0.0", { start: falls }));
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    await running(core, id);

    expect(stateOf(core, id).version).toBe("1.0.0");
    expect(home.calls).toContain(`UNDO ${id}`);
  });
});
