import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { maxDashboards } from "../src/dashboards/dashboards.js";
import { openLive, personWithClient } from "./devices-support.js";
import {
  claimed,
  get,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// Dashboards: the home's, not a person's or a client's. Every client reads and
// changes them, shared ones included, and a home always keeps Home. What is on
// Home is in home-dashboard.test.ts.

async function home() {
  const core = await testCore();
  const maya = await claimed(core);
  const add = async (body: object, call: { token: string } = maya) =>
    (await post(core, "/api/dashboards/add", body, call)).json();
  return { core, maya, add };
}

const seenBy = async (core: TestCore, token: string) =>
  (await get(core, "/api/dashboards", { token })).json();

function entries(core: TestCore) {
  return core.activity
    .recent()
    .filter((entry) => entry.source === "dashboards");
}

describe("dashboards", () => {
  it("start as Home on the mocha background, once", async () => {
    const { core, maya } = await home();

    const first = await seenBy(core, maya.token);
    // Starting again on the same database keeps it, and adds no other.
    const next = await testCore({ dataDir: core.dataDir });

    expect(first).toEqual([
      {
        id: expect.any(String),
        name: "Home",
        background: "mocha",
        kind: "home",
        devices: [],
      },
    ]);
    expect(next.dashboards.list()).toEqual(first);
    expect(entries(core)).toEqual([]);
  });

  it("move from a background the shell no longer draws to mocha on start", async () => {
    const { core, maya } = await home();
    core.db.run(sql`UPDATE dashboards SET background = 'burgundy'`);

    const next = await testCore({ dataDir: core.dataDir });

    expect(next.dashboards.list()).toEqual([
      expect.objectContaining({ name: "Home", background: "mocha" }),
    ]);
    expect(await seenBy(next, maya.token)).toEqual(next.dashboards.list());
  });

  it("are added after the others, renamed and removed, each in the activity log", async () => {
    const { core, maya, add } = await home();
    const [first] = await seenBy(core, maya.token);

    const kitchen = await add({ name: "Kitchen" });
    const evening = await add({ name: "Evening", background: "mocha" });
    const renamed = await post(
      core,
      "/api/dashboards/update",
      { id: kitchen.id, name: " Breakfast " },
      maya,
    );
    const renamedHome = await post(
      core,
      "/api/dashboards/update",
      { id: first.id, name: "Overview" },
      maya,
    );
    const removed = await post(
      core,
      "/api/dashboards/remove",
      { id: evening.id },
      maya,
    );

    expect(kitchen).toEqual({
      id: expect.any(String),
      name: "Kitchen",
      background: "mocha",
      kind: "custom",
    });
    expect(renamed.json()).toEqual({ ...kitchen, name: "Breakfast" });
    expect(renamedHome.json()).toEqual({ ...first, name: "Overview" });
    expect(removed.statusCode).toBe(204);
    expect(await seenBy(core, maya.token)).toEqual([
      { ...first, name: "Overview" },
      { ...kitchen, name: "Breakfast" },
    ]);
    expect(
      entries(core)
        .map((entry) => [entry.action, entry.subjectId])
        .sort(),
    ).toEqual(
      [
        ["dashboard.add", kitchen.id],
        ["dashboard.add", evening.id],
        ["dashboard.update", kitchen.id],
        ["dashboard.update", first.id],
        ["dashboard.remove", evening.id],
      ].sort(),
    );
    expect(entries(core)[0]).toMatchObject({
      outcome: "ok",
      personId: maya.person.id,
      clientId: maya.client.id,
    });
  });

  it("are read and changed by every client, shared ones included", async () => {
    const { core, maya, add } = await home();
    const kitchen = sharedClient(core);
    const callers = [
      { token: kitchen.token, clientId: kitchen.id, personId: null },
      ...["Ben", "Ida"].map((name) => {
        const person = personWithClient(core, name);
        return {
          token: person.token,
          clientId: person.client.id,
          personId: person.person.id,
        };
      }),
    ];

    for (const { token, clientId, personId } of callers) {
      const added = await add({ name: "Hallway" }, { token });
      const renamed = await post(
        core,
        "/api/dashboards/update",
        { id: added.id, name: "Landing" },
        { token },
      );
      const removed = await post(
        core,
        "/api/dashboards/remove",
        { id: added.id },
        { token },
      );

      expect(added).toMatchObject({ name: "Hallway" });
      expect(renamed.json()).toMatchObject({ name: "Landing" });
      expect(removed.statusCode).toBe(204);
      expect(await seenBy(core, token)).toEqual(await seenBy(core, maya.token));
      // The test's clock stands still, so the entries come in no order.
      expect(
        entries(core)
          .filter((entry) => entry.clientId === clientId)
          .map((entry) => [entry.action, entry.personId])
          .sort(),
      ).toEqual([
        ["dashboard.add", personId],
        ["dashboard.remove", personId],
        ["dashboard.update", personId],
      ]);
    }
    expect((await get(core, "/api/dashboards")).statusCode).toBe(401);
    expect(
      (await post(core, "/api/dashboards/add", { name: "Den" })).statusCode,
    ).toBe(401);
  });

  it("keep Home, from every client, first among them", async () => {
    const { core, maya, add } = await home();
    const kitchen = sharedClient(core);
    const [first] = await seenBy(core, maya.token);

    const refused = await post(
      core,
      "/api/dashboards/remove",
      { id: first.id },
      kitchen,
    );
    const second = await add({ name: "Kitchen" }, kitchen);
    const refusedAgain = await post(
      core,
      "/api/dashboards/remove",
      { id: first.id },
      maya,
    );
    // Even where Home's position comes after another's.
    core.db.run(sql`UPDATE dashboards SET position = 5 WHERE kind = 'home'`);

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "home_dashboard" });
    expect(refusedAgain.json()).toEqual({ error: "home_dashboard" });
    expect(await seenBy(core, maya.token)).toEqual([first, second]);
    // A refusal records nothing.
    expect(entries(core).map((entry) => entry.action)).toEqual([
      "dashboard.add",
    ]);
  });

  it(`stop at ${maxDashboards}`, async () => {
    const { core, maya, add } = await home();
    for (let each = 1; each < maxDashboards; each += 1) {
      await add({ name: `Dashboard ${each}` });
    }

    const refused = await post(
      core,
      "/api/dashboards/add",
      { name: "One more" },
      maya,
    );

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "too_many_dashboards" });
    expect(await seenBy(core, maya.token)).toHaveLength(maxDashboards);
  });

  it("refuse what does not exist and what is malformed", async () => {
    const { core, maya } = await home();
    const [first] = await seenBy(core, maya.token);

    for (const [url, body, status] of [
      ["/api/dashboards/update", { id: "nowhere", name: "Den" }, 404],
      ["/api/dashboards/remove", { id: "nowhere" }, 404],
      ["/api/dashboards/add", { name: " " }, 400],
      ["/api/dashboards/add", { name: "x".repeat(61) }, 400],
      ["/api/dashboards/add", { name: "Den", background: "neon" }, 400],
      ["/api/dashboards/update", { id: first.id }, 400],
      ["/api/dashboards/remove", {}, 400],
    ] as const) {
      expect((await post(core, url, body, maya)).statusCode).toBe(status);
    }
    expect(await seenBy(core, maya.token)).toEqual([first]);
  });

  it("are followed by live clients, shared ones too", async () => {
    const { core, maya, add } = await home();
    const mine = await openLive(core, maya.token);
    const shared = await openLive(core, sharedClient(core).token);
    const [first] = await seenBy(core, maya.token);

    const kitchen = await add({ name: "Kitchen" });

    // Messages arrive over the socket after the request has answered.
    for (const live of [mine, shared]) {
      await vi.waitFor(() =>
        expect(live.messages).toEqual([
          { type: "dashboards", dashboards: [first, kitchen] },
        ]),
      );
      live.socket.terminate();
    }
  });
});
