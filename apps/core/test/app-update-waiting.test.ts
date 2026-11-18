import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { appGrants } from "../src/app-host/schema.js";
import { useCleanUps } from "./app-apart-support.js";
import { id, version } from "./app-update-fixtures.js";
import {
  committedOf,
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
