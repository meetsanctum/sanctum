import { NotReady } from "@meetsanctum/app-sdk";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { appGrants } from "../src/app-host/schema.js";
import { useCleanUps } from "./app-apart-support.js";
import { id, version } from "./app-update-fixtures.js";
import {
  committedOf,
  rowOf,
  running,
  stateOf,
  versions,
} from "./app-update-support.js";
import { claimed, post } from "./support.js";
import type { TestCore } from "./support.js";

// An update that needs a permission nobody has granted waits for someone to
// allow it, the app on the version it has meanwhile; one with nothing new, or
// only optional ones, goes ahead.

useCleanUps();

const people = {
  id: "people.read",
  reason: "To know who's home.",
  needed: true,
};
const places = {
  id: "places.read",
  reason: "To know the rooms.",
  needed: true,
};

// The core answers what it asks for, as a home's does.
const asAHome = { allowed: false };

const answerOf = (core: TestCore, permission: string) =>
  core.db
    .select()
    .from(appGrants)
    .where(and(eq(appGrants.appId, id), eq(appGrants.permission, permission)))
    .get()?.granted;

const allowing = (core: TestCore) =>
  core.activity.recent().filter((entry) => entry.action === "allow-update");

describe("an update that needs a new permission", () => {
  it("waits, the app running the version it has", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0"), asAHome), id);
    home.calls.length = 0;

    const core = await home.coreWith(
      version("2.0.0", { permissions: [people] }),
      asAHome,
    );
    await running(core, id);

    expect(stateOf(core, id)).toMatchObject({
      version: "1.0.0",
      waiting: {
        id: expect.any(String),
        version: "2.0.0",
        build: "2.0.0+test",
        needs: [
          {
            id: "people.read",
            reason: "To know who's home.",
            needed: true,
          },
        ],
      },
    });
    expect(home.calls.some((call) => call.startsWith("BEGIN"))).toBe(false);
    expect(home.containers.at(-1)).toBe("1.0.0+test");
    expect(committedOf(core)?.version).toBe("1.0.0");
    // Nobody has answered it.
    expect(answerOf(core, "people.read")).toBeUndefined();
  });

  it("keeps waiting across a restart, under the same id", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0"), asAHome), id);
    const two = version("2.0.0", { permissions: [people] });
    const first = await home.coreWith(two, asAHome);
    await running(first, id);
    const waiting = stateOf(first, id).waiting!;

    const again = await home.coreWith(two, asAHome);
    await running(again, id);

    expect(stateOf(again, id).waiting?.id).toBe(waiting.id);
    expect(stateOf(again, id).version).toBe("1.0.0");
  });

  it("updates once someone allows it, granting only what it newly needs", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"), asAHome);
    await running(before, id);
    const maya = await claimed(before);
    const core = await home.coreWith(
      version("2.0.0", { permissions: [people] }),
      asAHome,
    );
    await running(core, id);
    const waiting = stateOf(core, id).waiting!;

    const answer = await post(
      core,
      `/api/apps/${id}/update/allow`,
      { id: waiting.id },
      maya,
    );

    expect(answer.statusCode).toBe(200);
    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"), {
      timeout: 4_000,
    });
    await running(core, id);
    expect(stateOf(core, id).waiting).toBeUndefined();
    expect(stateOf(core, id).permissions).toEqual(["people.read"]);
    expect(answerOf(core, "people.read")).toBe(true);
    expect(home.calls).toContain(`BEGIN ${id} 1.0.0 2.0.0`);
    expect(allowing(core)).toMatchObject([
      { outcome: "ok", kind: "setup", source: id },
    ]);
  });

  it("refuses an answer for another version, changing nothing", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"), asAHome);
    await running(before, id);
    const maya = await claimed(before);
    const core = await home.coreWith(
      version("2.0.0", { permissions: [people] }),
      asAHome,
    );
    await running(core, id);

    const answer = await post(
      core,
      `/api/apps/${id}/update/allow`,
      { id: "a-version-since-replaced" },
      maya,
    );

    expect(answer.statusCode).toBe(409);
    expect(stateOf(core, id).waiting?.version).toBe("2.0.0");
    expect(answerOf(core, "people.read")).toBeUndefined();
    expect(allowing(core)).toMatchObject([
      { outcome: "refused", reason: "conflict" },
    ]);
  });

  it("waits anew when it needs more than it showed, granting nothing", async () => {
    const home = await versions();
    const optional = { ...people, needed: false, startsOn: true };
    const before = await home.coreWith(
      version("1.0.0", { permissions: [optional] }),
      asAHome,
    );
    await running(before, id);
    const maya = await claimed(before);
    const core = await home.coreWith(
      version("2.0.0", { permissions: [people, places] }),
      asAHome,
    );
    await running(core, id);
    const shown = stateOf(core, id).waiting!;
    expect(shown.needs.map((request) => request.id)).toEqual(["places.read"]);
    // Someone switches off what the new version also needs.
    await post(
      core,
      `/api/apps/${id}/permissions/update`,
      { permission: "people.read", granted: false },
      maya,
    );

    const answer = await post(
      core,
      `/api/apps/${id}/update/allow`,
      { id: shown.id },
      maya,
    );

    expect(answer.statusCode).toBe(409);
    expect(answerOf(core, "places.read")).toBeUndefined();
    const now = stateOf(core, id).waiting!;
    expect(now.id).not.toBe(shown.id);
    expect(now.needs.map((request) => request.id)).toEqual([
      "people.read",
      "places.read",
    ]);
  });

  it("answers unavailable when its package can't be read, and can be asked again", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"), asAHome);
    await running(before, id);
    const maya = await claimed(before);
    const core = await home.coreWith(
      version("2.0.0", { permissions: [people] }),
      asAHome,
    );
    await running(core, id);
    const { id: waitingId } = stateOf(core, id).waiting!;
    home.packagesUnreadableFor(1);

    const first = await post(
      core,
      `/api/apps/${id}/update/allow`,
      { id: waitingId },
      maya,
    );
    expect(first.statusCode).toBe(503);
    expect(answerOf(core, "people.read")).toBeUndefined();

    const again = await post(
      core,
      `/api/apps/${id}/update/allow`,
      { id: waitingId },
      maya,
    );
    expect(again.statusCode).toBe(200);
    expect(allowing(core).map((entry) => entry.outcome)).toEqual([
      "ok",
      "failed",
    ]);
  });

  it("keeps its id across a restart only while it needs the same", async () => {
    const home = await versions();
    const optional = { ...people, needed: false, startsOn: true };
    const before = await home.coreWith(
      version("1.0.0", { permissions: [optional] }),
      asAHome,
    );
    await running(before, id);
    const two = version("2.0.0", { permissions: [people, places] });
    const first = await home.coreWith(two, asAHome);
    await running(first, id);
    const shown = stateOf(first, id).waiting!;
    first.db
      .update(appGrants)
      .set({ granted: false })
      .where(
        and(eq(appGrants.appId, id), eq(appGrants.permission, "people.read")),
      )
      .run();

    const again = await home.coreWith(two, asAHome);
    await running(again, id);

    expect(stateOf(again, id).waiting!.id).not.toBe(shown.id);
  });

  it("is replaced by a newer version, with what that one needs", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0"), asAHome), id);
    const first = await home.coreWith(
      version("2.0.0", { permissions: [people] }),
      asAHome,
    );
    await running(first, id);
    const before = stateOf(first, id).waiting!;

    const core = await home.coreWith(
      version("3.0.0", { permissions: [people, places] }),
      asAHome,
    );
    await running(core, id);

    const waiting = stateOf(core, id).waiting!;
    expect(waiting.version).toBe("3.0.0");
    expect(waiting.id).not.toBe(before.id);
    expect(waiting.needs.map((request) => request.id)).toEqual([
      "people.read",
      "places.read",
    ]);
    expect(stateOf(core, id).version).toBe("1.0.0");
  });

  it("asks again for one the household had switched off", async () => {
    const home = await versions();
    const optional = { ...people, needed: false };
    const before = await home.coreWith(
      version("1.0.0", { permissions: [optional] }),
      asAHome,
    );
    await running(before, id);
    expect(answerOf(before, "people.read")).toBe(false);

    const core = await home.coreWith(
      version("2.0.0", { permissions: [people] }),
      asAHome,
    );
    await running(core, id);

    expect(stateOf(core, id).version).toBe("1.0.0");
    expect(stateOf(core, id).waiting?.needs).toMatchObject([
      { id: "people.read" },
    ]);
  });

  it("refuses an approval overtaken by removal without granting anything", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"), asAHome);
    await running(before, id);
    const maya = await claimed(before);
    let release: (() => void) | undefined;
    let isHeld = false;
    const core = await home.coreWith(
      version("2.0.0", { permissions: [people] }),
      {
        ...asAHome,
        beforeLoad: async () => {
          if (isHeld) await new Promise<void>((done) => (release = done));
        },
      },
    );
    await running(core, id);
    isHeld = true;
    const answer = post(
      core,
      `/api/apps/${id}/update/allow`,
      { id: stateOf(core, id).waiting!.id },
      maya,
    );
    try {
      await vi.waitFor(() => expect(release).toBeDefined());
      await core.apps.remove(id);
    } finally {
      release?.();
    }

    expect((await answer).statusCode).toBe(409);
    expect(answerOf(core, "people.read")).toBeUndefined();
    expect(core.apps.list()).toEqual([]);
  });

  it("finishes an allowed update whose replacement failed before installation", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"), asAHome);
    await running(before, id);
    const maya = await claimed(before);
    const core = await home.coreWith(
      version("2.0.0", { permissions: [people] }),
      asAHome,
    );
    await running(core, id);
    const reconcile = vi
      .spyOn(core.entities, "reconcileTypes")
      .mockImplementationOnce(() => {
        throw new Error("The installation was interrupted");
      });

    expect(
      (
        await post(
          core,
          `/api/apps/${id}/update/allow`,
          { id: stateOf(core, id).waiting!.id },
          maya,
        )
      ).statusCode,
    ).toBe(200);

    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"));
    await running(core, id);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("refuses a waiting version after someone goes back", async () => {
    const home = await versions();
    const first = await home.coreWith(version("1.0.0"), asAHome);
    await running(first, id);
    const maya = await claimed(first);
    const second = await home.coreWith(version("2.0.0"), asAHome);
    await running(second, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    const core = await home.coreWith(
      version("3.0.0", { permissions: [people] }),
      asAHome,
    );
    await running(core, id);
    const waitingId = stateOf(core, id).waiting!.id;
    const back = await core.apps.goBackOption(id);

    expect(
      (await post(core, `/api/apps/${id}/go-back`, { id: back!.id }, maya))
        .statusCode,
    ).toBe(200);
    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("1.0.0"));
    await running(core, id);

    expect(stateOf(core, id).waiting).toBeUndefined();
    expect(
      (
        await post(
          core,
          `/api/apps/${id}/update/allow`,
          { id: waitingId },
          maya,
        )
      ).statusCode,
    ).toBe(409);
    expect(answerOf(core, "people.read")).toBeUndefined();
  });

  it("goes back only with its wait forgotten, both or neither", async () => {
    const home = await versions();
    const first = await home.coreWith(version("1.0.0"), asAHome);
    await running(first, id);
    const maya = await claimed(first);
    const second = await home.coreWith(version("2.0.0"), asAHome);
    await running(second, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    const core = await home.coreWith(
      version("3.0.0", { permissions: [people] }),
      asAHome,
    );
    await running(core, id);
    const waitingId = stateOf(core, id).waiting!.id;
    const back = await core.apps.goBackOption(id);
    vi.spyOn(core.waitingUpdates, "drop").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });

    const answer = await post(
      core,
      `/api/apps/${id}/go-back`,
      { id: back!.id },
      maya,
    );

    expect(answer.statusCode).toBe(409);
    expect(rowOf(core)).toBeUndefined();
    expect(stateOf(core, id)).toMatchObject({
      version: "2.0.0",
      waiting: { id: waitingId },
    });
  });

  it("lets only one of Go back and Allow sent together change the version", async () => {
    const home = await versions();
    const first = await home.coreWith(version("1.0.0"), asAHome);
    await running(first, id);
    const maya = await claimed(first);
    const second = await home.coreWith(version("2.0.0"), asAHome);
    await running(second, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    let release!: () => void;
    let isHeld = false;
    const held = new Promise<void>((resolve) => (release = resolve));
    const core = await home.coreWith(
      version("3.0.0", { permissions: [people] }),
      { ...asAHome, beforeLoad: () => (isHeld ? held : Promise.resolve()) },
    );
    await running(core, id);
    const waitingId = stateOf(core, id).waiting!.id;
    const back = await core.apps.goBackOption(id);
    isHeld = true;

    const answers = Promise.all([
      post(core, `/api/apps/${id}/go-back`, { id: back!.id }, maya),
      post(core, `/api/apps/${id}/update/allow`, { id: waitingId }, maya),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [goingBack, allowing] = await answers;

    expect([goingBack.statusCode, allowing.statusCode]).toEqual([200, 409]);
    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("1.0.0"));
    expect(answerOf(core, "people.read")).toBeUndefined();
  });

  it("keeps someone's Go back across a restart, whatever it needs", async () => {
    const home = await versions();
    const optional = { ...people, needed: false, startsOn: true };
    const first = await home.coreWith(
      version("1.0.0", { permissions: [optional] }),
      asAHome,
    );
    await running(first, id);
    const maya = await claimed(first);
    const two = version("2.0.0", { permissions: [people] });
    const second = await home.coreWith(two, asAHome);
    await running(second, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    const back = await second.apps.goBackOption(id);
    await post(second, `/api/apps/${id}/go-back`, { id: back!.id }, maya);
    await vi.waitFor(() => expect(committedOf(second)?.version).toBe("1.0.0"));
    await running(second, id);
    await post(
      second,
      `/api/apps/${id}/permissions/update`,
      { permission: "people.read", granted: false },
      maya,
    );

    const again = await home.coreWith(two, asAHome);
    await running(again, id);
    expect(stateOf(again, id)).toMatchObject({ version: "1.0.0" });
    expect(stateOf(again, id).waiting).toBeUndefined();
    await post(
      again,
      `/api/apps/${id}/permissions/update`,
      { permission: "people.read", granted: true },
      maya,
    );

    const later = await home.coreWith(two, asAHome);
    await running(later, id);
    expect(stateOf(later, id).version).toBe("1.0.0");
  });

  it("waits on an app's first move out of the core, stopped until someone allows it", async () => {
    const home = await versions();
    await home.ranInTheCore(version("1.0.0"));

    const core = await home.coreWith(
      version("2.0.0", { permissions: [people] }),
      asAHome,
    );

    await vi.waitFor(() =>
      expect(stateOf(core, id)).toMatchObject({
        version: "2.0.0",
        state: "paused",
        waiting: { version: "2.0.0" },
      }),
    );
    expect(answerOf(core, "people.read")).toBeUndefined();
  });

  it("isn't allowed when the version that waits can't run here", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"), asAHome);
    await running(before, id);
    const maya = await claimed(before);
    const two = version("2.0.0", { permissions: [people] });
    const core = await home.coreWith(two, asAHome);
    await running(core, id);
    home.builtForAnOlderProtocol(two);

    const answer = await post(
      core,
      `/api/apps/${id}/update/allow`,
      { id: stateOf(core, id).waiting!.id },
      maya,
    );

    expect(answer.statusCode).toBe(503);
    expect(answerOf(core, "people.read")).toBeUndefined();
    expect(stateOf(core, id).waiting?.version).toBe("2.0.0");
  });

  it("waits when a version tried again now needs what was switched off", async () => {
    let isReady = false;
    const home = await versions();
    const optional = { ...people, needed: false, startsOn: true };
    const before = await home.coreWith(
      version("1.0.0", { permissions: [optional] }),
      asAHome,
    );
    await running(before, id);
    const maya = await claimed(before);
    const core = await home.coreWith(
      version("2.0.0", {
        permissions: [people],
        start: async () => {
          if (!isReady) throw new NotReady("Waiting for something");
        },
      }),
      { ...asAHome, retryAfterMs: 200 },
    );
    await vi.waitFor(() => expect(home.calls).toContain(`UNDO ${id}`));
    await running(core, id);
    await post(
      core,
      `/api/apps/${id}/permissions/update`,
      { permission: "people.read", granted: false },
      maya,
    );
    isReady = true;

    await vi.waitFor(() =>
      expect(stateOf(core, id).waiting?.version).toBe("2.0.0"),
    );
    expect(stateOf(core, id).version).toBe("1.0.0");
    expect(committedOf(core)?.version).toBe("1.0.0");
  });

  it("stops the app when what it runs can't run here, until someone allows it", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"), asAHome);
    await running(before, id);
    const maya = await claimed(before);
    home.builtForAnOlderProtocol(version("1.0.0"));

    const core = await home.coreWith(
      version("2.0.0", { permissions: [people] }),
      asAHome,
    );

    await vi.waitFor(() =>
      expect(stateOf(core, id)).toMatchObject({
        version: "2.0.0",
        state: "paused",
        waiting: { version: "2.0.0" },
      }),
    );
    expect(answerOf(core, "people.read")).toBeUndefined();

    await post(
      core,
      `/api/apps/${id}/update/allow`,
      { id: stateOf(core, id).waiting!.id },
      maya,
    );

    await running(core, id);
    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"), {
      timeout: 4_000,
    });
    expect(stateOf(core, id).waiting).toBeUndefined();
  });

  it("clears the wait when its installed build receives all its needed permissions", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"), asAHome);
    await running(before, id);
    const maya = await claimed(before);
    home.builtForAnOlderProtocol(version("1.0.0"));
    const core = await home.coreWith(
      version("2.0.0", { permissions: [people, places] }),
      asAHome,
    );
    await vi.waitFor(() => expect(stateOf(core, id).state).toBe("paused"));

    await post(
      core,
      `/api/apps/${id}/permissions/update`,
      { permission: people.id, granted: true },
      maya,
    );
    expect(stateOf(core, id).waiting).toBeDefined();
    await post(
      core,
      `/api/apps/${id}/permissions/update`,
      { permission: places.id, granted: true },
      maya,
    );
    await running(core, id);

    expect(stateOf(core, id).waiting).toBeUndefined();
  });

  it.each(["3.0.0", "2.0.0"])(
    "replaces a stopped waiting build with %s without granting its permissions",
    async (nextVersion) => {
      const home = await versions();
      await running(await home.coreWith(version("1.0.0"), asAHome), id);
      home.builtForAnOlderProtocol(version("1.0.0"));
      const second = await home.coreWith(
        version("2.0.0", { permissions: [people] }),
        asAHome,
      );
      await vi.waitFor(() => expect(stateOf(second, id).state).toBe("paused"));
      const waitingId = stateOf(second, id).waiting!.id;

      const build = `${nextVersion}+rebuilt`;
      const core = await home.coreWith(
        version(nextVersion, { permissions: [people, places] }),
        { ...asAHome, folder: build },
      );

      expect(stateOf(core, id)).toMatchObject({
        version: nextVersion,
        state: "paused",
        waiting: {
          version: nextVersion,
          build,
          needs: [{ id: people.id }, { id: places.id }],
        },
      });
      expect(stateOf(core, id).waiting!.id).not.toBe(waitingId);
      expect(answerOf(core, people.id)).toBeUndefined();
      expect(answerOf(core, places.id)).toBeUndefined();
    },
  );
});

describe("an update with nothing new to allow", () => {
  it("goes ahead with a new optional permission off, even one it starts with", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0"), asAHome), id);
    const startsOn = { ...people, needed: false, startsOn: true };

    const core = await home.coreWith(
      version("2.0.0", { permissions: [startsOn] }),
      asAHome,
    );
    await running(core, id);

    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"), {
      timeout: 4_000,
    });
    expect(stateOf(core, id).waiting).toBeUndefined();
    expect(answerOf(core, "people.read")).toBe(false);
  });

  it("goes ahead when what it needs is already granted", async () => {
    const home = await versions();
    const before = await home.coreWith(
      version("1.0.0", { permissions: [people] }),
      asAHome,
    );
    await running(before, id);
    expect(answerOf(before, "people.read")).toBe(true);

    const core = await home.coreWith(
      version("2.0.0", { permissions: [people] }),
      asAHome,
    );
    await running(core, id);

    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"), {
      timeout: 4_000,
    });
    expect(stateOf(core, id).waiting).toBeUndefined();
  });
});
