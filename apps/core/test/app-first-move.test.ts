import { NotReady } from "@meetsanctum/app-sdk";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { useCleanUps } from "./app-apart-support.js";
import { appSettings, appUpdates } from "../src/app-host/schema.js";
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

// An app's first move from the core's process to its own container, with its file. Its
// commit says it has moved. Until then its original is as it was, and whatever goes
// wrong it carries on in the core's process. After that it never goes back there.

useCleanUps();

const inProcess = version("1.0.0");
const original = (core: TestCore) => join(core.dataDir, "apps", `${id}.db`);

// A release from before apps ran apart: the app in the core's process, with its file.
async function onTodaysRelease() {
  const home = await versions();
  const core = await home.coreWith(inProcess, { isInProcessOnly: true });
  await running(core, id);
  home.calls.length = 0;
  return { home, core };
}

// Whether it runs in the core's process, where nothing supervises a container.
const isInTheCore = (core: TestCore) => stateOf(core, id).run === undefined;

describe("a first move that works", () => {
  it("takes in its file, starts apart, and says so once it has committed", async () => {
    const { home } = await onTodaysRelease();
    const asked = vi.spyOn(home.manager, "beginAppUpdate");
    const seen: Seen = [];

    const core = await home.coreWith(version("1.0.0", { seen }), { inProcess });
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
    expect(isInTheCore(core)).toBe(false);
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
      { inProcess },
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
    const core = await home.coreWith(version("1.0.0"), { inProcess });
    await running(core, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    const { token } = await claimed(core);

    const answer = await get(core, `/api/apps/${id}/go-back`, { token });

    expect(answer.json()).toEqual({ to: null });
  });

  it("leaves its original until its next update has committed", async () => {
    const { home } = await onTodaysRelease();
    const moved = await home.coreWith(version("1.0.0"), { inProcess });
    await running(moved, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    mkdirSync(join(moved.dataDir, "apps"), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      writeFileSync(`${original(moved)}${suffix}`, "as it was");
    }
    expect(existsSync(original(moved))).toBe(true);

    const next = await home.coreWith(version("2.0.0"), { inProcess });
    await running(next, id);

    await vi.waitFor(() => {
      expect(existsSync(original(next))).toBe(false);
      expect(existsSync(`${original(next)}-wal`)).toBe(false);
      expect(existsSync(`${original(next)}-shm`)).toBe(false);
    });
  });

  it("waits until someone turns on one that's off", async () => {
    const { home, core: before } = await onTodaysRelease();
    const { token } = await claimed(before);
    await post(before, `/api/apps/${id}/off`, { off: true }, { token });

    const core = await home.coreWith(version("1.0.0"), { inProcess });
    await new Promise((done) => setTimeout(done, 30));
    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toEqual([]);

    await post(core, `/api/apps/${id}/off`, { off: false }, { token });
    await running(core, id);

    expect(committedOf(core)?.folder).toBe("1.0.0+test");
  });
});

describe("a first move that doesn't work", () => {
  const backInTheCore = async (
    core: TestCore,
    home: Awaited<ReturnType<typeof versions>>,
  ) => {
    await vi.waitFor(() => expect(isInTheCore(core)).toBe(true));
    await running(core, id);
    expect(committedOf(core)?.folder).toBeNull();
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    expect(home.calls).toContain(`UNDO ${id}`);
  };

  it("carries on in the core's process if it fails, and stays there", async () => {
    const { home } = await onTodaysRelease();
    const failing = version("1.0.0", { start: falls });

    const core = await home.coreWith(failing, { inProcess });
    await backInTheCore(core, home);
    expect(rowOf(core)).toMatchObject({
      status: "undone",
      failure: expect.any(String),
    });
    home.calls.length = 0;

    const next = await home.coreWith(failing, { inProcess });
    await running(next, id);

    expect(isInTheCore(next)).toBe(true);
    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toEqual([]);
  });

  it("can be installed in the core again after a failed move was removed", async () => {
    const { home } = await onTodaysRelease();
    const core = await home.coreWith(version("1.0.0", { start: falls }), {
      inProcess,
    });
    await backInTheCore(core, home);

    await core.apps.remove(id);
    await core.apps.start([{ app: inProcess, origin: "official" }]);

    expect(core.apps.has(id)).toBe(true);
    await running(core, id);
    expect(isInTheCore(core)).toBe(true);
  });

  it("tries again when another version arrives", async () => {
    const { home } = await onTodaysRelease();
    const first = await home.coreWith(version("1.0.0", { start: falls }), {
      inProcess,
    });
    await backInTheCore(first, home);

    const core = await home.coreWith(version("1.1.0"), { inProcess });
    await running(core, id);

    expect(isInTheCore(core)).toBe(false);
    expect(committedOf(core)?.folder).toBe("1.1.0+test");
    expect(rowOf(core)).toBeUndefined();
  });

  it.each(["failure", "power cut"])(
    "restores settings the in-process version accepts after a %s",
    async (ending) => {
      const settings = (choices: [string, ...string[]]) =>
        z.object({
          mode: z
            .enum(choices)
            .default(choices[0])
            .meta({
              title: "Mode",
              options: Object.fromEntries(choices.map((each) => [each, each])),
            }),
          name: z.string().default("").meta({ title: "Name" }),
        });
      const home = await versions();
      const originalPackage = version("1.0.0", {
        settings: settings(["calm", "bright"]),
      });
      const before = await home.coreWith(originalPackage, {
        isInProcessOnly: true,
      });
      before.db
        .insert(appSettings)
        .values({
          appId: id,
          values: { mode: "bright", name: "Before" },
          updatedAt: new Date(),
        })
        .run();
      let finish!: () => void;
      const held = new Promise<void>((done) => {
        finish = done;
      });
      const apart = version("1.1.0", {
        settings: settings(["calm", "bright", "vivid"]),
        start: async () => {
          await held;
          await falls();
        },
      });
      let core = await home.coreWith(apart, { inProcess: originalPackage });
      await vi.waitFor(() => expect(rowOf(core)?.status).toBe("starting"));
      core.db
        .update(appSettings)
        .set({ values: { mode: "vivid", name: "During" } })
        .run();

      if (ending === "power cut") {
        await home.powerCut(core);
        core = await home.coreWith(originalPackage, { isInProcessOnly: true });
        await core.apps.committed();
      } else {
        finish();
      }
      await backInTheCore(core, home);

      expect(core.db.select().from(appSettings).get()?.values).toEqual({
        mode: "bright",
        name: "During",
      });
    },
  );

  it("carries on there if it isn't ready, and tries again when it's time", async () => {
    const { home } = await onTodaysRelease();
    const waiting = version("1.0.0", {
      start: async () => {
        throw new NotReady("Waiting for the test");
      },
    });

    const first = await home.coreWith(waiting, {
      inProcess,
      retryAfterMs: 0,
    });
    await backInTheCore(first, home);
    expect(rowOf(first)?.retryAt).toBeInstanceOf(Date);

    const core = await home.coreWith(version("1.0.0"), { inProcess });
    await running(core, id);

    expect(isInTheCore(core)).toBe(false);
    expect(committedOf(core)?.folder).toBe("1.0.0+test");
  });

  it("carries on there if the manager refuses for good", async () => {
    const { home } = await onTodaysRelease();
    home.manager.beginAppUpdate = async () => {
      throw new ManagerRefusal("It can't be done", 400);
    };

    const core = await home.coreWith(version("1.0.0"), { inProcess });

    await vi.waitFor(() => expect(isInTheCore(core)).toBe(true));
    await running(core, id);
    expect(committedOf(core)?.folder).toBeNull();
  });

  it("waits for its turn while the slot is taken", async () => {
    const { home } = await onTodaysRelease();
    const begin = home.manager.beginAppUpdate;
    let taken = true;
    home.manager.beginAppUpdate = async (app, request) => {
      if (taken) throw new ManagerRefusal("Something else is running", 409);
      await begin(app, request);
    };

    const core = await home.coreWith(version("1.0.0"), { inProcess });
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("waiting"));
    taken = false;
    await running(core, id);

    expect(committedOf(core)?.folder).toBe("1.0.0+test");
  });

  it("carries on there after waiting too long for its turn", async () => {
    const { home } = await onTodaysRelease();
    home.manager.beginAppUpdate = async () => {
      throw new ManagerRefusal("Something else is running", 409);
    };

    const core = await home.coreWith(version("1.0.0"), { inProcess });
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("waiting"));
    core.advance(10 * 60_000);

    await vi.waitFor(() => expect(isInTheCore(core)).toBe(true));
    await running(core, id);
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
    const core = await home.coreWith(moving, { inProcess });
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

    const core = await home.coreWith(moving, { inProcess });
    await running(core, id);

    expect(isInTheCore(core)).toBe(false);
    expect(committedOf(core)?.folder).toBe("1.0.0+test");
  });

  it("after it started leaves it in the core's process, its file as it was", async () => {
    const { home, moving } = await cutAt("starting");

    const core = await home.coreWith(moving, { inProcess });
    await running(core, id);

    expect(isInTheCore(core)).toBe(true);
    expect(rowOf(core)?.status).toBe("undone");
    // As any core does once no update of its own is on trial.
    await core.apps.committed();
    await vi.waitFor(() => expect(home.calls).toContain(`UNDO ${id}`));
    expect(home.journal.size).toBe(0);
  });

  it("gives way to another version that arrived meanwhile", async () => {
    const { home } = await cutAt("starting");

    const core = await home.coreWith(version("1.1.0"), { inProcess });
    await running(core, id);

    expect(isInTheCore(core)).toBe(false);
    expect(committedOf(core)?.version).toBe("1.1.0");
  });
});

describe("once it has moved", () => {
  const moved = async () => {
    const { home } = await onTodaysRelease();
    const core = await home.coreWith(version("1.0.0"), { inProcess });
    await running(core, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    home.calls.length = 0;
    return { home };
  };

  it("doesn't move again", async () => {
    const { home } = await moved();

    const core = await home.coreWith(version("1.0.0"), { inProcess });
    await running(core, id);

    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toEqual([]);
    expect(isInTheCore(core)).toBe(false);
  });

  it("never goes back to the core's process, even with nothing apart to go by", async () => {
    const { home } = await moved();

    const core = await home.coreWith(inProcess, { isInProcessOnly: true });
    await running(core, id);

    expect(isInTheCore(core)).toBe(false);
    expect(committedOf(core)?.folder).toBe("1.0.0+test");
  });

  it("is undone as any update after that, not sent back to the core's process", async () => {
    const { home } = await moved();

    const core = await home.coreWith(version("2.0.0", { start: falls }), {
      inProcess,
    });
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    await running(core, id);

    expect(isInTheCore(core)).toBe(false);
    expect(stateOf(core, id).version).toBe("1.0.0");
    expect(home.calls).toContain(`UNDO ${id}`);
  });

  it("undoes an interrupted later update with only its in-process package bundled", async () => {
    const { home } = await moved();
    const core = await home.coreWith(
      version("2.0.0", { start: async () => new Promise(() => undefined) }),
      { inProcess },
    );
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("starting"));
    await home.powerCut(core);
    home.calls.length = 0;

    const recovered = await home.coreWith(inProcess, { isInProcessOnly: true });
    await running(recovered, id);

    expect(home.calls).toContain(`UNDO ${id}`);
    expect(rowOf(recovered)?.status).toBe("undone");
    expect(committedOf(recovered)?.folder).toBe("1.0.0+test");
    expect(isInTheCore(recovered)).toBe(false);
  });
});

describe("a first move with no package in the core's process", () => {
  it("takes in its file all the same, rather than start without it", async () => {
    const { home } = await onTodaysRelease();
    const asked = vi.spyOn(home.manager, "beginAppUpdate");

    const core = await home.coreWith(version("1.0.0"));
    await running(core, id);

    expect(asked.mock.calls[0]?.[1]).toMatchObject({ moves: `${id}.db` });
    expect(committedOf(core)?.folder).toBe("1.0.0+test");
    expect(rowOf(core)).toBeUndefined();
  });

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

  it("goes on from the copy after a power cut, not taking it in again", async () => {
    const { home } = await onTodaysRelease();
    let holds = true;
    const moving = version("1.0.0", {
      start: async () => {
        if (holds) await new Promise(() => undefined);
      },
    });
    const core = await home.coreWith(moving);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("starting"));
    await home.powerCut(core);
    holds = false;
    home.calls.length = 0;

    const next = await home.coreWith(moving);
    await running(next, id);

    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toEqual([]);
    expect(home.calls.filter((each) => each.startsWith("UNDO"))).toEqual([]);
    expect(committedOf(next)?.folder).toBe("1.0.0+test");
  });

  it("starts the move again if its package goes after one that failed", async () => {
    const { home } = await onTodaysRelease();
    const first = await home.coreWith(version("1.0.0", { start: falls }), {
      inProcess,
    });
    await vi.waitFor(() => expect(rowOf(first)?.status).toBe("undone"));
    await running(first, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    home.calls.length = 0;

    const core = await home.coreWith(version("1.0.0"));
    await running(core, id);

    expect(home.calls).toContain(`BEGIN ${id} 1.0.0 1.0.0`);
    expect(committedOf(core)?.folder).toBe("1.0.0+test");
  });

  it("starts apart with nothing to take in, for an app that never ran before", async () => {
    const home = await versions();

    const core = await home.coreWith(version("1.0.0"));
    await running(core, id);

    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toEqual([]);
  });
});
