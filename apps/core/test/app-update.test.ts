import { NotReady } from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { useCleanUps } from "./app-apart-support.js";
import { appSettings, appUpdates } from "../src/app-host/schema.js";
import { falls, id, version, type Seen } from "./app-update-fixtures.js";
import { claimed, post } from "./support.js";
import {
  committedOf,
  rowOf,
  running,
  stateOf,
  versions,
} from "./app-update-support.js";

// An app's update, through its failures: a new version that fails is undone, and the
// old one rebuilds what it owns from its own database.

useCleanUps();

describe("an update that works", () => {
  it("copies its data for a new build of the same version", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    home.calls.length = 0;
    const seen: Seen = [];

    const core = await home.coreWith(version("1.0.0", { seen }), {
      folder: "1.0.0+rebuilt",
    });
    await running(core, id);

    expect(home.calls).toContain(`BEGIN ${id} 1.0.0 1.0.0`);
    expect(seen).toEqual([{ reason: "updated", from: "1.0.0" }]);
    expect(committedOf(core)?.folder).toBe("1.0.0+rebuilt");
  });

  it("copies its data first, starts it, and lets the manager go once committed", async () => {
    const seen: Seen = [];
    const home = await versions();
    const one = version("1.0.0");
    await running(await home.coreWith(one), id);

    const core = await home.coreWith(version("2.0.0", { seen }));
    await running(core, id);

    expect(seen).toEqual([{ reason: "updated", from: "1.0.0" }]);
    expect(home.calls.filter((each) => /BEGIN|COMMIT|UNDO/.test(each))).toEqual(
      [`BEGIN ${id} 1.0.0 2.0.0`, `COMMIT ${id}`],
    );
    expect(home.containers).toEqual(["1.0.0+test", "2.0.0+test"]);
    expect(rowOf(core)).toBeUndefined();
    expect(committedOf(core)).toMatchObject({
      version: "2.0.0",
      folder: "2.0.0+test",
    });
  });

  it("names the update in the row that commits it", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    let update: string | undefined;
    const begin = home.manager.beginAppUpdate;
    home.manager.beginAppUpdate = async (app, request) => {
      update = request.id;
      await begin(app, request);
    };

    const core = await home.coreWith(version("2.0.0"));
    await running(core, id);

    expect(committedOf(core)?.updateId).toBe(update);
  });

  it("runs nothing of it until the manager has the copy", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    let give!: () => void;
    const copied = new Promise<void>((done) => {
      give = done;
    });
    const begin = home.manager.beginAppUpdate;
    home.manager.beginAppUpdate = async (app, request) => {
      await copied;
      await begin(app, request);
    };
    home.containers.length = 0;

    const core = await home.coreWith(version("2.0.0"));
    await new Promise((done) => setTimeout(done, 30));
    expect(home.containers).toEqual([]);
    expect(rowOf(core)?.status).toBe("waiting");

    give();
    await running(core, id);

    expect(home.containers).toEqual(["2.0.0+test"]);
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

  it("does nothing while it's off, and updates when it's turned on", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"));
    await running(before, id);
    const maya = await claimed(before);
    await post(before, `/api/apps/${id}/off`, { off: true }, maya);
    await vi.waitFor(() => expect(stateOf(before, id).state).toBe("off"));
    home.calls.length = 0;

    const core = await home.coreWith(version("2.0.0"));
    await new Promise((done) => setTimeout(done, 30));
    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toEqual([]);
    expect(stateOf(core, id).state).toBe("off");

    await post(core, `/api/apps/${id}/off`, { off: false }, maya);
    await running(core, id);

    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toHaveLength(
      1,
    );
    expect(committedOf(core)?.version).toBe("2.0.0");
  });
});

describe("a new version that fails", () => {
  it("remembers a failed start even if someone turns the app off meanwhile", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"));
    await running(before, id);
    const maya = await claimed(before);
    let finish!: () => void;
    const held = new Promise<void>((done) => {
      finish = done;
    });
    const start = vi.fn(async () => {
      await held;
      throw new Error("The update failed");
    });
    const core = await home.coreWith(version("2.0.0", { start }));
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

    await post(core, `/api/apps/${id}/off`, { off: true }, maya);
    finish();
    await vi.waitFor(() =>
      expect(stateOf(core, id)).toMatchObject({
        state: "off",
        version: "1.0.0",
      }),
    );
    await post(core, `/api/apps/${id}/off`, { off: false }, maya);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));

    expect(start).toHaveBeenCalledOnce();
    expect(stateOf(core, id)).toMatchObject({
      state: "running",
      version: "1.0.0",
    });
  });

  it("ignores a rollback package loaded after the app was replaced", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    let give!: () => void;
    const held = new Promise<void>((done) => {
      give = done;
    });
    const loading = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => held)
      .mockResolvedValue(undefined);
    const core = await home.coreWith(version("2.0.0", { start: falls }), {
      beforeLoad: loading,
    });
    await vi.waitFor(() => expect(loading).toHaveBeenCalled());
    await core.apps.remove(id);
    await core.apps.start([home.packageOf(version("3.0.0"))]);
    await running(core, id);
    const installedNow = core.apps.list().find((app) => app.id === id);

    give();
    await new Promise((done) => setTimeout(done, 30));

    expect(stateOf(core, id)).toEqual(installedNow);
  });

  it("is undone: the copy goes back, and the old version starts, told so", async () => {
    const seen: Seen = [];
    const home = await versions();
    const one = version("1.0.0", { seen });
    await running(await home.coreWith(one), id);
    seen.length = 0;
    home.calls.length = 0;

    const core = await home.coreWith(version("2.0.0", { start: falls }));

    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    expect(seen).toEqual([{ reason: "rolledBack", from: "2.0.0" }]);
    expect(home.calls.filter((each) => /BEGIN|COMMIT|UNDO/.test(each))).toEqual(
      [`BEGIN ${id} 1.0.0 2.0.0`, `UNDO ${id}`],
    );
    expect(stateOf(core, id)).toMatchObject({
      version: "1.0.0",
      state: "running",
    });
    expect(committedOf(core)).toMatchObject({
      version: "1.0.0",
      folder: "1.0.0+test",
    });
    expect(rowOf(core)?.failure).toBe("failed_start");
  });

  it("keeps trying to go back when the old package can't be read at first", async () => {
    const seen: Seen = [];
    const home = await versions();
    await running(await home.coreWith(version("1.0.0", { seen })), id);
    seen.length = 0;
    home.packagesUnreadableFor(2);

    const core = await home.coreWith(version("2.0.0", { start: falls }));

    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    expect(seen).toEqual([{ reason: "rolledBack", from: "2.0.0" }]);
    expect(stateOf(core, id).version).toBe("1.0.0");
  });

  it("rebuilds what it owns from the old version's claims, and only that", async () => {
    const home = await versions();
    const one = version("1.0.0", { notes: ["mine"] });
    await running(await home.coreWith(one), id);

    const core = await home.coreWith(
      version("2.0.0", {
        notes: ["from the failed one"],
        start: falls,
      }),
    );
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));

    expect(core.entities.list({ app: id }).map(({ key }) => key)).toEqual([
      "mine",
    ]);
  });

  it("is undone for a crash before its commit, not restarted", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    home.containers.length = 0;

    const core = await home.coreWith(
      version("2.0.0", {
        start: async () => {
          process.nextTick(() => void home.stopContainer());
          await new Promise(() => undefined);
        },
      }),
    );

    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    expect(home.containers).toEqual(["2.0.0+test", "1.0.0+test"]);
    expect(rowOf(core)?.failure).toBe("crashed");
  });

  it("restarts as any app once it has committed, and fails no more updates", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const core = await home.coreWith(version("2.0.0"));
    await running(core, id);
    home.calls.length = 0;

    await home.stopContainer();

    await vi.waitFor(() => expect(stateOf(core, id).run?.failures).toBe(1));
    await running(core, id);
    expect(home.calls.filter((each) => each.startsWith("UNDO"))).toEqual([]);
    expect(committedOf(core)?.version).toBe("2.0.0");
  });

  it("stays on the old version across a restart, not trying that one again", async () => {
    const seen: Seen = [];
    const home = await versions();
    const one = version("1.0.0", { seen });
    await running(await home.coreWith(one), id);
    const failing = version("2.0.0", { start: falls });
    const first = await home.coreWith(failing);
    await vi.waitFor(() => expect(rowOf(first)?.status).toBe("undone"));
    seen.length = 0;
    home.calls.length = 0;

    const core = await home.coreWith(failing);
    await running(core, id);

    expect(stateOf(core, id).version).toBe("1.0.0");
    expect(seen).toEqual([{ reason: "started" }]);
    expect(home.calls.filter((each) => /BEGIN|UNDO/.test(each))).toEqual([]);
  });

  it("tries again when a newer version arrives", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const first = await home.coreWith(version("2.0.0", { start: falls }));
    await vi.waitFor(() => expect(rowOf(first)?.status).toBe("undone"));

    const core = await home.coreWith(version("3.0.0"));
    await running(core, id);

    expect(committedOf(core)?.version).toBe("3.0.0");
    expect(rowOf(core)).toBeUndefined();
  });

  it("puts back settings the old version won't accept, and keeps those it will", async () => {
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
    const before = await home.coreWith(
      version("1.0.0", { settings: settings(["calm", "bright"]) }),
    );
    await running(before, id);
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

    const core = await home.coreWith(
      version("2.0.0", {
        settings: settings(["calm", "bright", "vivid"]),
        start: async () => {
          await held;
          throw new Error("It fell over");
        },
      }),
    );
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("starting"));
    // Someone changes them while it starts, one the old version doesn't know.
    core.db
      .update(appSettings)
      .set({ values: { mode: "vivid", name: "During" } })
      .where(eq(appSettings.appId, id))
      .run();
    finish();
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));

    expect(core.db.select().from(appSettings).get()?.values).toEqual({
      mode: "bright",
      name: "During",
    });
  });
});

describe("what clients are told of an update", () => {
  it("starts the quiet period while the manager is still making the copy", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    let finish!: () => void;
    const copied = new Promise<void>((done) => {
      finish = done;
    });
    const begin = home.manager.beginAppUpdate;
    home.manager.beginAppUpdate = async (app, request) => {
      await copied;
      await begin(app, request);
    };

    const core = await home.coreWith(version("2.0.0"), { quietMs: 100 });
    expect(rowOf(core)?.status).toBe("waiting");
    expect(stateOf(core, id).run?.quiet).toBe(true);
    await vi.waitFor(() =>
      expect(stateOf(core, id).run?.quiet).toBeUndefined(),
    );
    expect(stateOf(core, id).run?.update).toEqual({
      stage: "updating",
      to: "2.0.0",
    });
    finish();
    await running(core, id);
  });

  it("says it's updating while it waits and starts, and nothing once it has", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    let finish!: () => void;
    const held = new Promise<void>((done) => {
      finish = done;
    });

    const core = await home.coreWith(version("2.0.0", { start: () => held }));

    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("starting"));
    expect(stateOf(core, id).run?.update).toEqual({
      stage: "updating",
      to: "2.0.0",
    });
    finish();
    await running(core, id);
    expect(stateOf(core, id).run?.update).toBeUndefined();
  });

  it("says it's going back while its data does", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    let give!: () => void;
    const restored = new Promise<void>((done) => {
      give = done;
    });
    const undo = home.manager.undoAppUpdate;
    home.manager.undoAppUpdate = async (app, update) => {
      await restored;
      await undo(app, update);
    };

    const core = await home.coreWith(version("2.0.0", { start: falls }));

    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undoing"));
    await vi.waitFor(() =>
      expect(stateOf(core, id)?.run?.update).toEqual({
        stage: "goingBack",
        to: "1.0.0",
      }),
    );
    await vi.waitFor(() => expect(stateOf(core, id).run?.quiet).toBe(true));
    give();
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
  });

  it("says which version it went back from, and whether it tries again", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);

    const failed = await home.coreWith(version("2.0.0", { start: falls }));
    await vi.waitFor(() => expect(rowOf(failed)?.status).toBe("undone"));
    await running(failed, id);
    expect(stateOf(failed, id).run?.update).toEqual({
      stage: "wentBack",
      from: "2.0.0",
      triesAgain: false,
    });

    const waiting = await home.coreWith(
      version("3.0.0", {
        start: async () => {
          throw new NotReady("Waiting for Zigbee2MQTT");
        },
      }),
    );
    await vi.waitFor(() => expect(rowOf(waiting)?.toVersion).toBe("3.0.0"));
    await vi.waitFor(() => expect(rowOf(waiting)?.status).toBe("undone"));
    await running(waiting, id);
    expect(stateOf(waiting, id).run?.update).toEqual({
      stage: "wentBack",
      from: "3.0.0",
      triesAgain: true,
    });
  });
});

describe("a power cut", () => {
  const stopsAt = async (
    status: (typeof appUpdates.$inferSelect)["status"],
  ) => {
    const home = await versions();
    const seen: Seen = [];
    const one = version("1.0.0", { seen, notes: ["mine"] });
    await running(await home.coreWith(one), id);
    let hold = true;
    const two = version("2.0.0", {
      notes: ["from the new one"],
      start: async () => {
        if (hold) await new Promise(() => undefined);
      },
    });
    const core = await home.coreWith(two);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("starting"));
    await vi.waitFor(() =>
      expect(core.entities.list({ app: id }).map(({ key }) => key)).toContain(
        "from the new one",
      ),
    );
    if (status !== "starting") {
      core.db.update(appUpdates).set({ status }).run();
    }
    await home.powerCut(core);
    hold = false;
    seen.length = 0;
    home.calls.length = 0;
    return { home, seen, one, two };
  };

  it("before its commit undoes it, as the next core finds", async () => {
    const { home, seen, two } = await stopsAt("starting");

    const core = await home.coreWith(two);

    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    expect(seen).toEqual([{ reason: "rolledBack", from: "2.0.0" }]);
    expect(stateOf(core, id).version).toBe("1.0.0");
    expect(home.calls.filter((each) => each.startsWith("UNDO"))).toEqual([
      `UNDO ${id}`,
    ]);
    expect(core.entities.list({ app: id }).map(({ key }) => key)).toEqual([
      "mine",
    ]);
  });

  it("while undoing carries on, holding the old version back until its data is", async () => {
    const { home, seen, two } = await stopsAt("undoing");
    let give!: () => void;
    const restored = new Promise<void>((done) => {
      give = done;
    });
    const undo = home.manager.undoAppUpdate;
    home.manager.undoAppUpdate = async (app, update) => {
      await restored;
      await undo(app, update);
    };

    const core = await home.coreWith(two);
    await new Promise((done) => setTimeout(done, 30));
    expect(seen).toEqual([]);
    expect(rowOf(core)?.status).toBe("undoing");

    give();
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    expect(seen).toEqual([{ reason: "rolledBack", from: "2.0.0" }]);
  });

  it("after its data is back doesn't ask for it again", async () => {
    const { home, seen, two } = await stopsAt("restored");

    const core = await home.coreWith(two);

    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    expect(seen).toEqual([{ reason: "rolledBack", from: "2.0.0" }]);
    expect(home.calls.filter((each) => each.startsWith("UNDO"))).toEqual([]);
  });

  it("finishes rebuilding the old version when that package arrives again", async () => {
    const { home, seen, one } = await stopsAt("restored");
    home.journal.delete(id);

    const core = await home.coreWith(one);
    await running(core, id);

    expect(core.entities.list({ app: id }).map(({ key }) => key)).toEqual([
      "mine",
    ]);
    expect(seen).toEqual([{ reason: "rolledBack", from: "2.0.0" }]);
    expect(rowOf(core)?.status).toBe("undone");
    expect(home.calls.filter((each) => each.startsWith("UNDO"))).toEqual([]);
  });

  it("after its data is back takes a newer version, not the old one again", async () => {
    const home = await versions();
    let comesBack = true;
    const one = version("1.0.0", {
      start: async () => {
        if (!comesBack) await new Promise(() => undefined);
      },
    });
    await running(await home.coreWith(one), id);
    comesBack = false;
    const first = await home.coreWith(version("2.0.0", { start: falls }));
    await vi.waitFor(() => expect(rowOf(first)?.status).toBe("restored"));
    await home.powerCut(first);
    home.calls.length = 0;

    const core = await home.coreWith(version("3.0.0"));
    await running(core, id);

    expect(committedOf(core)?.version).toBe("3.0.0");
    expect(rowOf(core)).toBeUndefined();
    expect(home.calls.filter((each) => each.startsWith("UNDO"))).toEqual([]);
  });

  it("before the manager had the copy just asks again", async () => {
    const { home, two } = await stopsAt("waiting");

    const core = await home.coreWith(two);
    await running(core, id);

    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toHaveLength(
      1,
    );
    expect(committedOf(core)?.version).toBe("2.0.0");
  });

  it("leaves it all until a core on trial has committed", async () => {
    const { home, seen, two } = await stopsAt("starting");

    const core = await home.coreWith(two, { onTrial: true });
    await new Promise((done) => setTimeout(done, 30));
    expect(seen).toEqual([]);
    expect(home.calls.filter((each) => each.startsWith("UNDO"))).toEqual([]);

    await core.apps.committed();
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));

    expect(seen).toEqual([{ reason: "rolledBack", from: "2.0.0" }]);
  });
});

describe("catching the manager up", () => {
  it("waits for recovery when the manager is temporarily unavailable", async () => {
    const home = await versions();
    const list = home.manager.appUpdates;
    let answering = false;
    home.manager.appUpdates = async () => {
      if (!answering) throw new Error("The manager is starting");
      return list();
    };

    const core = await home.coreWith(version("1.0.0"));
    await vi.waitFor(() => expect(stateOf(core, id).state).toBe("waiting"));
    expect(home.containers).toEqual([]);
    answering = true;
    await running(core, id);
  });

  it("stops retrying recovery when the core closes", async () => {
    const home = await versions();
    const list = vi.fn(async () => {
      throw new Error("The manager is unavailable");
    });
    home.manager.appUpdates = list;
    const core = await home.coreWith(version("1.0.0"));
    await core.apps.committed();
    await vi.waitFor(() => expect(list).toHaveBeenCalled());

    await core.apps.close();
    const attempts = list.mock.calls.length;
    await new Promise((done) => setTimeout(done, 30));

    expect(list).toHaveBeenCalledTimes(attempts);
    expect(home.containers).toEqual([]);
  });

  it("retries a missed commit without restarting the core", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const commit = home.manager.commitAppUpdate;
    let hearing = false;
    home.manager.commitAppUpdate = async (app, update) => {
      if (!hearing) throw new Error("The manager did not answer");
      await commit(app, update);
    };
    const core = await home.coreWith(version("2.0.0"));
    await core.apps.committed();
    await running(core, id);
    expect(home.journal.size).toBe(1);

    hearing = true;

    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    expect(home.calls).not.toContain(`UNDO ${id}`);
  });

  it("keeps the commit's identity through an ordinary restart", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const two = version("2.0.0");
    const first = await home.coreWith(two);
    await running(first, id);
    const committed = committedOf(first)?.updateId;

    const core = await home.coreWith(two);
    await running(core, id);

    expect(committedOf(core)?.updateId).toBe(committed);
  });

  it("never undoes a committed update after the app has restarted", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const commit = home.manager.commitAppUpdate;
    home.manager.commitAppUpdate = async () => {
      throw new Error("The manager did not answer");
    };
    const two = version("2.0.0");
    const first = await home.coreWith(two);
    await running(first, id);
    expect(home.journal.size).toBe(1);

    home.manager.commitAppUpdate = commit;
    const core = await home.coreWith(two);
    await running(core, id);
    home.calls.length = 0;
    await core.apps.committed();

    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    expect(home.calls).not.toContain(`UNDO ${id}`);
  });

  it("restores an orphaned update before starting the app", async () => {
    const home = await versions();
    home.journal.set(id, { id: "lost" });
    let restore!: () => void;
    const restored = new Promise<void>((done) => {
      restore = done;
    });
    const undo = home.manager.undoAppUpdate;
    const undoing = vi.fn(async (app: string, update: string) => {
      await restored;
      await undo(app, update);
    });
    home.manager.undoAppUpdate = undoing;

    const starting = home.coreWith(version("1.0.0"));
    try {
      await vi.waitFor(() => expect(undoing).toHaveBeenCalled());
      expect(home.containers).toEqual([]);
    } finally {
      restore();
    }
    await running(await starting, id);
  });

  it("tells it of a commit it never heard", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const commit = home.manager.commitAppUpdate;
    let hearing = false;
    home.manager.commitAppUpdate = async (app, update) => {
      if (hearing) await commit(app, update);
      else throw new Error("The manager did not answer");
    };
    const two = version("2.0.0");
    const first = await home.coreWith(two);
    await running(first, id);
    expect(home.journal.size).toBe(1);
    hearing = true;

    const core = await home.coreWith(two);
    await core.apps.committed();

    await vi.waitFor(() => expect(home.journal.size).toBe(0));
  });

  it("undoes one the core has no record of, as its copy is all that's left", async () => {
    const home = await versions();
    home.journal.set(id, { id: "lost" });
    const one = version("1.0.0");

    const core = await home.coreWith(one);
    await core.apps.committed();

    await vi.waitFor(() => expect(home.calls).toContain(`UNDO ${id}`));
    expect(home.journal.size).toBe(0);
  });
});
