import { NotReady, type AppGoBack } from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { useCleanUps } from "./app-apart-support.js";
import { appSettings, appUpdates } from "../src/app-host/schema.js";
import { ManagerRefusal } from "../src/manager.js";
import { id, version, type Seen } from "./app-update-fixtures.js";
import { claimed, get, post, type TestCore } from "./support.js";
import {
  committedOf,
  rowOf,
  running,
  stateOf,
  versions,
} from "./app-update-support.js";

// Someone going back from an app's last update: an update in the other direction,
// through the same steps, whose failure returns to the newer version.

useCleanUps();

// One claim for each data folder, whichever core has it open now.
const claims = new Map<string, ReturnType<typeof claimed>>();
const signedIn = (core: TestCore) => {
  let claim = claims.get(core.dataDir);
  if (!claim) {
    claim = claimed(core);
    claims.set(core.dataDir, claim);
  }
  return claim;
};

const offered = async (core: TestCore) =>
  (await get(core, `/api/apps/${id}/go-back`, await signedIn(core))).json<{
    to: AppGoBack | null;
  }>().to;

const press = async (core: TestCore) =>
  post(
    core,
    `/api/apps/${id}/go-back`,
    { id: (await offered(core))?.id ?? "unavailable" },
    await signedIn(core),
  );

// An app that updated from 1.0.0 to 2.0.0 and committed.
async function updated(options: { oldStart?: () => Promise<void> } = {}) {
  const home = await versions();
  const seen: Seen = [];
  const one = version("1.0.0", {
    seen,
    notes: ["from the old one"],
    start: async () => options.oldStart?.(),
  });
  await running(await home.coreWith(one), id);
  const twoSeen: Seen = [];
  const two = version("2.0.0", {
    seen: twoSeen,
    notes: ["from the new one"],
  });
  const core = await home.coreWith(two);
  await running(core, id);
  await vi.waitFor(() => expect(home.journal.size).toBe(0));
  seen.length = 0;
  home.calls.length = 0;
  return { home, core, one, two, seen, twoSeen };
}

describe("what it offers", () => {
  it("nothing before an update, then the version before it, with when", async () => {
    const home = await versions();
    const first = await home.coreWith(version("1.0.0"));
    await running(first, id);
    expect(await offered(first)).toBeNull();

    const core = await home.coreWith(version("2.0.0"));
    await running(core, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));

    expect(await offered(core)).toEqual({
      id: expect.any(String),
      version: "1.0.0",
      since: "2026-11-02T10:00:00.000Z",
    });
  });

  it("nothing while it's off", async () => {
    const { core } = await updated();
    await post(
      core,
      `/api/apps/${id}/off`,
      { off: true },
      await signedIn(core),
    );

    expect(await offered(core)).toBeNull();
    expect((await press(core)).statusCode).toBe(409);
  });

  it("nothing while its current version is starting again", async () => {
    const { home } = await updated();
    let finish!: () => void;
    const started = new Promise<void>((done) => {
      finish = done;
    });
    const core = await home.coreWith(
      version("2.0.0", { start: async () => started }),
    );
    await vi.waitFor(() => expect(stateOf(core, id).state).toBe("starting"));

    try {
      expect(await offered(core)).toBeNull();
      expect((await press(core)).statusCode).toBe(409);
      expect(rowOf(core)).toBeUndefined();
    } finally {
      finish();
    }
    await running(core, id);
    expect(await offered(core)).toMatchObject({ version: "1.0.0" });
  });

  it("nothing if the manager can't say", async () => {
    const { core, home } = await updated();
    home.manager.keptAppCopy = async () => {
      throw new Error("The manager did not answer");
    };

    expect(await offered(core)).toBeNull();
    expect((await press(core)).statusCode).toBe(409);
    expect(stateOf(core, id).version).toBe("2.0.0");
  });

  it("refuses a confirmation for a copy replaced by another update", async () => {
    const { core, home } = await updated();
    const confirmed = await offered(core);
    const next = await home.coreWith(version("3.0.0"));
    await running(next, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));

    const answer = await post(
      next,
      `/api/apps/${id}/go-back`,
      { id: confirmed!.id },
      await signedIn(next),
    );

    expect(answer.statusCode).toBe(409);
    expect(stateOf(next, id).version).toBe("3.0.0");
    expect(rowOf(next)).toBeUndefined();
  });

  it("requires the copy someone confirmed before starting", async () => {
    const { core } = await updated();

    const answer = await post(
      core,
      `/api/apps/${id}/go-back`,
      {},
      await signedIn(core),
    );

    expect(answer.statusCode).toBe(400);
    expect(stateOf(core, id).version).toBe("2.0.0");
    expect(rowOf(core)).toBeUndefined();
  });

  it("nothing while a permission it needs is off", async () => {
    const home = await versions();
    const withPermission = (number: string) => ({
      ...version(number),
      permissions: [
        { id: "places.read", reason: "For the test.", needed: true },
      ],
    });
    await running(await home.coreWith(withPermission("1.0.0")), id);
    const core = await home.coreWith(withPermission("2.0.0"));
    await running(core, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    await core.apps.setPermission({
      principal: core.auth.clients.authenticate((await signedIn(core)).token)!,
      appId: id,
      permission: "places.read",
      granted: false,
    });
    await vi.waitFor(() => expect(stateOf(core, id).state).toBe("paused"));

    expect(await offered(core)).toBeNull();
    expect((await press(core)).statusCode).toBe(409);
    expect(rowOf(core)).toBeUndefined();
  });
});

describe("going back", () => {
  it("puts the kept copy in place, and the old version starts, told so", async () => {
    const { core, home, seen } = await updated();

    expect((await press(core)).statusCode).toBe(200);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    await running(core, id);

    expect(home.calls).toContain(`BEGIN ${id} 2.0.0 1.0.0`);
    expect(seen).toEqual([{ reason: "rolledBack", from: "2.0.0" }]);
    expect(stateOf(core, id).version).toBe("1.0.0");
    expect(committedOf(core)?.version).toBe("1.0.0");
    expect(core.entities.list({ app: id }).map(({ key }) => key)).toEqual([
      "from the old one",
    ]);
    expect(stateOf(core, id).run?.update).toEqual({
      stage: "wentBack",
      from: "2.0.0",
      triesAgain: false,
      chosen: true,
    });
    await vi.waitFor(() => expect(home.calls).toContain(`COMMIT ${id}`));
  });

  it("says it's going back while it does, and offers nothing meanwhile", async () => {
    let comesBack!: () => void;
    const held = new Promise<void>((done) => {
      comesBack = done;
    });
    let holds = false;
    const { core } = await updated({
      oldStart: async () => {
        if (holds) await held;
      },
    });
    holds = true;

    await press(core);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("starting"));

    expect(stateOf(core, id).run?.update).toEqual({
      stage: "goingBack",
      to: "1.0.0",
    });
    expect(await offered(core)).toBeNull();
    expect((await press(core)).statusCode).toBe(409);
    comesBack();
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
  });

  it("offers nothing more once it has", async () => {
    const { core, home } = await updated();
    await press(core);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    await vi.waitFor(() => expect(home.journal.size).toBe(0));

    expect(await offered(core)).toBeNull();
  });

  it("stays there across a restart, though the core still brings what it left", async () => {
    const { core, home, two, seen } = await updated();
    await press(core);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    await running(core, id);
    await vi.waitFor(() => expect(home.calls).toContain(`COMMIT ${id}`));
    seen.length = 0;
    home.calls.length = 0;

    const next = await home.coreWith(two);
    await running(next, id);

    expect(stateOf(next, id).version).toBe("1.0.0");
    expect(seen).toEqual([{ reason: "started" }]);
    expect(home.calls.filter((each) => /BEGIN|UNDO/.test(each))).toEqual([]);
  });

  it("takes another version when one arrives, updating from the old one", async () => {
    const { core, home } = await updated();
    await press(core);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    await running(core, id);
    home.calls.length = 0;

    const next = await home.coreWith(version("3.0.0"));
    await running(next, id);

    expect(home.calls).toContain(`BEGIN ${id} 1.0.0 3.0.0`);
    expect(committedOf(next)?.version).toBe("3.0.0");
    expect(rowOf(next)).toBeUndefined();
  });
});

describe("going back that doesn't work", () => {
  const backOnTheNewOne = async (
    core: TestCore,
    home: Awaited<ReturnType<typeof versions>>,
  ) => {
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    await running(core, id);
    expect(stateOf(core, id).version).toBe("2.0.0");
    expect(stateOf(core, id).run?.update).toEqual({
      stage: "wentBack",
      from: "1.0.0",
      triesAgain: false,
    });
    expect(home.calls).toContain(`UNDO ${id}`);
  };

  it("returns to the newer version if the old one fails", async () => {
    let fails = false;
    const { core, home, twoSeen } = await updated({
      oldStart: async () => {
        if (fails) throw new Error("It fell over");
      },
    });
    fails = true;
    twoSeen.length = 0;

    await press(core);

    await backOnTheNewOne(core, home);
    expect(twoSeen).toEqual([{ reason: "rolledBack", from: "1.0.0" }]);
    expect(core.entities.list({ app: id }).map(({ key }) => key)).toEqual([
      "from the new one",
    ]);
    // Its copy is still kept, so it can be asked for again.
    expect(await offered(core)).toMatchObject({ version: "1.0.0" });
  });

  it("returns to the newer version if the old one isn't ready, not trying later", async () => {
    let notReady = false;
    const { core, home } = await updated({
      oldStart: async () => {
        if (notReady) throw new NotReady("Waiting for the test");
      },
    });
    notReady = true;

    await press(core);

    await backOnTheNewOne(core, home);
    expect(rowOf(core)?.retryAt).toBeNull();
  });

  it("returns to the newer version if the manager refuses for good", async () => {
    const { core, home } = await updated();
    home.manager.beginAppUpdate = async () => {
      throw new ManagerRefusal("No such copy to go back to", 404);
    };

    await press(core);

    await backOnTheNewOne(core, home);
  });

  it("waits for its turn while the slot is taken", async () => {
    const { core, home } = await updated();
    const begin = home.manager.beginAppUpdate;
    let taken = true;
    home.manager.beginAppUpdate = async (app, request) => {
      if (taken) throw new ManagerRefusal("Something else is running", 409);
      await begin(app, request);
    };

    await press(core);
    await vi.waitFor(() =>
      expect(stateOf(core, id).run?.waitingFor).toBe(
        "Waiting for its turn to go back",
      ),
    );
    expect(rowOf(core)?.status).toBe("waiting");

    taken = false;
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    expect(stateOf(core, id).version).toBe("1.0.0");
  });
});

describe("waiting too long for its turn", () => {
  it("returns to the newer version, rather than leave it down", async () => {
    const { core, home } = await updated();
    const begin = home.manager.beginAppUpdate;
    let taken = true;
    home.manager.beginAppUpdate = async (app, request) => {
      if (taken) throw new ManagerRefusal("Something else is running", 409);
      await begin(app, request);
    };
    await press(core);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("waiting"));
    await vi.waitFor(() =>
      expect(stateOf(core, id).run?.waitingFor).toBe(
        "Waiting for its turn to go back",
      ),
    );

    core.advance(10 * 60_000);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    taken = false;
    await running(core, id);

    expect(stateOf(core, id).version).toBe("2.0.0");
  });
});

describe("a power cut going back", () => {
  const cutAt = async (status: "waiting" | "starting") => {
    let holds = false;
    const parts = await updated({
      oldStart: async () => {
        if (holds) await new Promise(() => undefined);
      },
    });
    holds = true;
    await press(parts.core);
    await vi.waitFor(() => expect(rowOf(parts.core)?.status).toBe("starting"));
    if (status === "waiting") {
      parts.core.db.update(appUpdates).set({ status }).run();
    }
    await parts.home.powerCut(parts.core);
    holds = false;
    parts.seen.length = 0;
    parts.home.calls.length = 0;
    return parts;
  };

  it("before the old version started carries on, as someone asked", async () => {
    const { home, two, seen } = await cutAt("waiting");

    const core = await home.coreWith(two);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    await running(core, id);

    expect(stateOf(core, id).version).toBe("1.0.0");
    expect(seen).toEqual([{ reason: "rolledBack", from: "2.0.0" }]);
  });

  it("while the old version started undoes it, returning to the newer one", async () => {
    const { home, two } = await cutAt("starting");

    const core = await home.coreWith(two);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    await running(core, id);

    expect(stateOf(core, id).version).toBe("2.0.0");
    expect(home.calls.filter((each) => each.startsWith("UNDO"))).toEqual([
      `UNDO ${id}`,
    ]);
  });

  it("gives way to another version that arrived meanwhile", async () => {
    const { home } = await cutAt("waiting");

    const core = await home.coreWith(version("3.0.0"));
    await running(core, id);

    expect(committedOf(core)?.version).toBe("3.0.0");
    expect(rowOf(core)).toBeUndefined();
  });
});

describe("its settings", () => {
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

  it("stay where the old version accepts them, and return to what they were", async () => {
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
    const core = await home.coreWith(
      version("2.0.0", { settings: settings(["calm", "bright", "vivid"]) }),
    );
    await running(core, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    // One the old version doesn't know, and one it does.
    core.db
      .update(appSettings)
      .set({ values: { mode: "vivid", name: "Since" } })
      .where(eq(appSettings.appId, id))
      .run();

    await press(core);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));

    expect(core.db.select().from(appSettings).get()?.values).toEqual({
      mode: "bright",
      name: "Since",
    });
  });

  it("come back as they were if going back fails", async () => {
    let fails = false;
    const home = await versions();
    const one = version("1.0.0", {
      settings: settings(["calm", "bright"]),
      start: async () => {
        if (fails) throw new Error("It fell over");
      },
    });
    const before = await home.coreWith(one);
    await running(before, id);
    before.db
      .insert(appSettings)
      .values({
        appId: id,
        values: { mode: "bright", name: "Before" },
        updatedAt: new Date(),
      })
      .run();
    const core = await home.coreWith(
      version("2.0.0", { settings: settings(["calm", "bright", "vivid"]) }),
    );
    await running(core, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    core.db
      .insert(appSettings)
      .values({
        appId: id,
        values: { mode: "vivid", name: "Mine" },
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: appSettings.appId,
        set: { values: { mode: "vivid", name: "Mine" } },
      })
      .run();
    fails = true;

    await press(core);
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));

    expect(stateOf(core, id).version).toBe("2.0.0");
    expect(core.db.select().from(appSettings).get()?.values).toEqual({
      mode: "vivid",
      name: "Mine",
    });
  });
});
