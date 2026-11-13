import { defineApp, toStaticManifest } from "@meetsanctum/app-sdk";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createActivity } from "../src/activity/activity.js";
import { loadAppPackage } from "./runner-apps.js";
import {
  claimed,
  fixtureApps,
  get,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// Calling apps' actions through the client route, with the permission gate in
// between.

async function notesCore() {
  const notes = await loadAppPackage(join(fixtureApps, "notes"), "system");
  const core = await testCore({ apps: [notes] });
  const maya = await claimed(core);
  return { core, maya };
}

function call(core: TestCore, token: string, action: string, input?: object) {
  return post(core, `/api/apps/test.notes/actions/${action}`, input, {
    token,
  });
}

// Someone with a personal client of their own, as signing in creates one.
function personWithClient(core: TestCore) {
  const person = core.people.add({ name: "Ben", colour: "#8fb5c9" });
  const { token } = core.auth.clients.createPersonal({
    name: "Ben's phone",
    platform: "android",
    personId: person.id,
  });
  return { person, token };
}

function entries(core: TestCore) {
  return createActivity(core.db)
    .recent()
    .filter((entry) => entry.source === "test.notes");
}

describe("calling an action", () => {
  it("runs it as the person behind a personal client", async () => {
    const { core, maya } = await notesCore();

    const added = await call(core, maya.token, "notes.add", {
      text: "Milk",
      personal: true,
    });
    const listed = await call(core, maya.token, "notes.list", {});

    expect(added.statusCode).toBe(200);
    expect(added.json()).toEqual({ id: 1 });
    expect(listed.json()).toEqual([{ id: 1, text: "Milk", personal: true }]);
    // What may change something is logged; reads are not.
    expect(entries(core)).toEqual([
      expect.objectContaining({
        action: "notes.add",
        outcome: "ok",
        personId: maya.client.personId,
        clientId: maya.client.id,
      }),
    ]);
  });

  it("needs a client token, like every route that is not public", async () => {
    const { core } = await notesCore();

    const response = await post(
      core,
      "/api/apps/test.notes/actions/notes.list",
      {},
    );

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_client_token" });
  });

  it("answers 404 for an app or action that is not installed", async () => {
    const { core, maya } = await notesCore();

    for (const url of [
      "/api/apps/test.missing/actions/notes.list",
      "/api/apps/test.notes/actions/notes.missing",
    ]) {
      const response = await post(core, url, {}, { token: maya.token });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
    }
  });

  it("checks the input against the action's schema", async () => {
    const { core, maya } = await notesCore();

    const response = await call(core, maya.token, "notes.add", { text: "" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });

  it("lets everyone run every tier, destructive ones included", async () => {
    const { core, maya } = await notesCore();
    const ben = personWithClient(core);
    await call(core, maya.token, "notes.add", { text: "Old" });

    const cleared = await call(core, ben.token, "notes.clear", {});

    expect(cleared.json()).toEqual({ cleared: 1 });
    expect(entries(core)).toContainEqual(
      expect.objectContaining({
        action: "notes.clear",
        outcome: "ok",
        personId: ben.person.id,
      }),
    );
  });

  it("refuses someone removed from the household", async () => {
    const { core } = await notesCore();
    const ben = personWithClient(core);
    const actor = { kind: "user", id: ben.person.id } as const;
    core.gate.permit(actor, { tier: "write" });

    core.people.remove(ben.person.id);

    expect(() => core.gate.permit(actor, { tier: "write" })).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
  });

  it("allows renaming shared and owned notes but protects another person's note", async () => {
    const { core, maya } = await notesCore();
    const ben = personWithClient(core);
    await call(core, maya.token, "notes.add", {
      text: "Private",
      personal: true,
    });
    await call(core, maya.token, "notes.add", { text: "Board" });
    expect(
      (
        await call(core, ben.token, "notes.rename", { id: 1, text: "Changed" })
      ).json(),
    ).toEqual({ renamed: false });
    expect(
      (
        await call(core, ben.token, "notes.rename", { id: 2, text: "Shared" })
      ).json(),
    ).toEqual({ renamed: true });
    expect((await call(core, maya.token, "notes.list", {})).json()).toEqual([
      { id: 1, text: "Private", personal: true },
      { id: 2, text: "Shared", personal: false },
    ]);
    expect(
      (
        await call(core, maya.token, "notes.rename", { id: 1, text: "Mine" })
      ).json(),
    ).toEqual({ renamed: true });
  });
});

describe("a shared client", () => {
  it("reaches every action as the client actor", async () => {
    const { core } = await notesCore();
    const tablet = sharedClient(core);

    const added = await call(core, tablet.token, "notes.add", {
      text: "Bread",
    });
    const listed = await call(core, tablet.token, "notes.list", {});

    expect(added.statusCode).toBe(200);
    expect(listed.json()).toEqual([{ id: 1, text: "Bread", personal: false }]);
    // The activity log names the client, and no person.
    expect(entries(core)).toEqual([
      expect.objectContaining({
        action: "notes.add",
        outcome: "ok",
        personId: null,
        clientId: tablet.id,
      }),
    ]);
  });

  it("changes and destroys as anyone may, and it is logged", async () => {
    const { core, maya } = await notesCore();
    const tablet = sharedClient(core);
    await call(core, maya.token, "notes.add", { text: "Bread" });

    const renamed = await call(core, tablet.token, "notes.rename", {
      id: 1,
      text: "Toast",
    });
    const cleared = await call(core, tablet.token, "notes.clear", {});

    expect(renamed.json()).toEqual({ renamed: true });
    expect(cleared.json()).toEqual({ cleared: 1 });
    const changed = entries(core).filter(
      (entry) => entry.clientId === tablet.id,
    );
    expect(changed.map((entry) => entry.action).sort()).toEqual([
      "notes.clear",
      "notes.rename",
    ]);
    for (const entry of changed) {
      expect(entry).toMatchObject({ outcome: "ok", personId: null });
    }
  });

  it("is refused what the app itself refuses, and it is logged", async () => {
    const { core, maya } = await notesCore();
    const tablet = sharedClient(core);
    await call(core, maya.token, "notes.add", { text: "Gift", personal: true });
    await call(core, maya.token, "notes.add", { text: "Bread" });

    const personal = await call(core, tablet.token, "notes.add", {
      text: "Mine",
      personal: true,
    });
    const listed = await call(core, tablet.token, "notes.list", {});

    // The app checks the resource and refuses; the core logs it.
    expect(personal.statusCode).toBe(403);
    expect(personal.json()).toEqual({ error: "forbidden" });
    expect(entries(core)).toContainEqual(
      expect.objectContaining({
        action: "notes.add",
        outcome: "refused",
        reason: "forbidden",
        clientId: tablet.id,
      }),
    );
    expect(listed.json()).toEqual([{ id: 2, text: "Bread", personal: false }]);
  });
});

describe("listing apps", () => {
  const app = (id: string, name: string, extra: object = {}) => ({
    origin: "official" as const,
    app: defineApp({
      id,
      name,
      version: "0.2.0",
      core: "^1.0.0",
      permissions: [{ id: "places.read", reason: "For the test." }],
      actions: [],
      events: [],
      ...extra,
    }),
  });

  it("gives every client the installed apps by name, with their icons and pages", async () => {
    const core = await testCore({
      apps: [
        app("test.rooms", "Rooms", {
          icon: { glyph: "sofa", color: "ember" },
          pages: ["main", "room"],
        }),
        app("test.bridge", "Bridge"),
      ],
    });
    const maya = await claimed(core);
    const kitchen = sharedClient(core);

    const listed = await get(core, "/api/apps", { token: maya.token });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      {
        id: "test.bridge",
        name: "Bridge",
        version: "0.2.0",
        icon: null,
        pages: [],
        permissions: ["places.read"],
        requests: [
          {
            id: "places.read",
            reason: "For the test.",
            needed: false,
            asked: null,
            startsOn: false,
          },
        ],
        state: "running",
        run: { since: "2026-10-26T12:00:00.000Z" },
        settings: null,
        provides: {
          entities: [],
          widgets: [],
          roomSections: [],
          devicePages: [],
        },
      },
      {
        id: "test.rooms",
        name: "Rooms",
        version: "0.2.0",
        icon: { glyph: "sofa", color: "ember" },
        pages: ["main", "room"],
        permissions: ["places.read"],
        requests: [
          {
            id: "places.read",
            reason: "For the test.",
            needed: false,
            asked: null,
            startsOn: false,
          },
        ],
        state: "running",
        run: { since: "2026-10-26T12:00:00.000Z" },
        settings: null,
        provides: {
          entities: [],
          widgets: [],
          roomSections: [],
          devicePages: [],
        },
      },
    ]);
    expect(
      (await get(core, "/api/apps", { token: kitchen.token })).json(),
    ).toEqual(listed.json());
    expect((await get(core, "/api/apps")).statusCode).toBe(401);
  });

  it("serve each app's manifest, for its settings page", async () => {
    const rooms = app("test.rooms", "Rooms");
    const core = await testCore({ apps: [rooms] });
    const maya = await claimed(core);
    const kitchen = sharedClient(core);

    const manifest = await get(core, "/api/apps/test.rooms/manifest", {
      token: kitchen.token,
    });

    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toEqual(
      JSON.parse(JSON.stringify(toStaticManifest(rooms.app))),
    );
    expect(
      (await get(core, "/api/apps/test.gone/manifest", { token: maya.token }))
        .statusCode,
    ).toBe(404);
    expect((await get(core, "/api/apps/test.rooms/manifest")).statusCode).toBe(
      401,
    );
  });
});
