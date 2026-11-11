import {
  defineAction,
  defineApp,
  type AppInfo,
  type PermissionRequest,
  type PermissionsEvent,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createActivity } from "../src/activity/activity.js";
import { ActionCallError } from "../src/app-host/errors.js";
import { claimed, get, post, testCore, type TestCore } from "./support.js";

// Apps' grants: every permission an app asks for comes with its reason, the
// core keeps whether the household granted it, the app reads what it may do now
// with ctx.permissions.list(), and a running app hears a change as
// permissions.changed.

// What the app may do now, how often that changed, and whether it may
// still read places.
const holds = defineAction({
  id: "rooms.holds",
  title: "What it holds",
  tier: "read",
  input: z.object({}),
  output: z.object({
    granted: z.array(z.string()),
    revision: z.number(),
    places: z.boolean(),
  }),
  async run(ctx) {
    const places = await ctx.places.list().then(
      () => true,
      () => false,
    );
    return {
      granted: await ctx.permissions.list(),
      revision: await ctx.permissions.revision(),
      places,
    };
  },
});

// A job of its own, which needs no permission.
const tidy = defineAction({
  id: "rooms.tidy",
  title: "Tidy",
  tier: "write",
  input: z.object({}),
  output: z.object({ scheduled: z.boolean() }),
  async run(ctx) {
    await ctx.jobs.schedule({
      key: "tidy",
      action: tidy,
      input: {},
      when: { at: "2026-10-27T12:00:00Z" },
    });
    return { scheduled: true };
  },
});

function roomsApp(
  heard: PermissionsEvent[] = [],
  more: PermissionRequest[] = [],
) {
  return {
    origin: "official" as const,
    app: defineApp({
      id: "test.rooms",
      name: "Rooms",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [
        {
          id: "places.read",
          reason: "To list your rooms.",
          asked: "when you choose a room",
        },
        { id: "people.read", reason: "To show who lives here.", needed: true },
        ...more,
      ],
      actions: [holds, tidy],
      events: [],
      async start(ctx) {
        await ctx.events.on("permissions.changed", async (event) => {
          heard.push(event);
        });
      },
    }),
  };
}

async function signedIn(core: TestCore) {
  const maya = await claimed(core);
  const principal = core.auth.clients.authenticate(maya.token)!;
  return { maya, principal };
}

async function run(core: TestCore, token: string, action: string) {
  const response = await post(
    core,
    `/api/apps/test.rooms/actions/${action}`,
    {},
    { token },
  );
  return response.json();
}

describe("apps' grants", () => {
  it("are what the app needs and what starts on, when the core first sees it ask, and the rest wait until asked", async () => {
    const lights = {
      id: "devices.read:light",
      reason: "To show each room's lights.",
      startsOn: true,
    };
    const core = await testCore({
      apps: [roomsApp([], [lights])],
      allowed: false,
    });
    const { maya } = await signedIn(core);

    const listed = await get(core, "/api/apps", { token: maya.token });
    const rooms = (listed.json() as AppInfo[]).find(
      (app) => app.id === "test.rooms",
    )!;

    expect(rooms.permissions).toEqual(["people.read", "devices.read:light"]);
    expect(rooms.requests).toEqual([
      {
        id: "places.read",
        reason: "To list your rooms.",
        needed: false,
        asked: "when you choose a room",
        startsOn: false,
      },
      {
        id: "people.read",
        reason: "To show who lives here.",
        needed: true,
        asked: null,
        startsOn: false,
      },
      {
        id: "devices.read:light",
        reason: "To show each room's lights.",
        needed: false,
        asked: null,
        startsOn: true,
      },
    ]);
    expect(rooms.state).toBe("running");
    expect(await run(core, maya.token, "rooms.holds")).toEqual({
      granted: ["people.read", "devices.read:light"],
      revision: 0,
      places: false,
    });
  });

  it("change through the gate, and the app hears it and loses what it covered at once", async () => {
    const heard: PermissionsEvent[] = [];
    const core = await testCore({ apps: [roomsApp(heard)] });
    const { maya, principal } = await signedIn(core);

    const granted = await core.apps.setPermission({
      principal,
      appId: "test.rooms",
      permission: "places.read",
      granted: false,
    });

    expect(granted).toEqual(["people.read"]);
    expect(await run(core, maya.token, "rooms.holds")).toEqual({
      granted: ["people.read"],
      revision: 1,
      places: false,
    });
    await expect
      .poll(() => heard)
      .toEqual([
        {
          name: "permissions.changed",
          granted: ["people.read"],
          before: ["places.read", "people.read"],
        },
      ]);
    const listed = await get(core, "/api/apps", { token: maya.token });
    expect(
      (listed.json() as AppInfo[]).find((app) => app.id === "test.rooms")!
        .permissions,
    ).toEqual(["people.read"]);
    // Back again, the grants are as they were and the revision has moved on.
    await core.apps.setPermission({
      principal,
      appId: "test.rooms",
      permission: "places.read",
      granted: true,
    });
    expect(await run(core, maya.token, "rooms.holds")).toMatchObject({
      granted: ["places.read", "people.read"],
      revision: 2,
    });
  });

  it("go to the activity log with whoever changed them", async () => {
    const core = await testCore({ apps: [roomsApp()] });
    const { principal } = await signedIn(core);

    await core.apps.setPermission({
      principal,
      appId: "test.rooms",
      permission: "people.read",
      granted: false,
    });
    // The same answer again changes nothing and records nothing.
    await core.apps.setPermission({
      principal,
      appId: "test.rooms",
      permission: "people.read",
      granted: false,
    });

    const entries = createActivity(core.db)
      .recent()
      .filter((entry) => entry.action === "permissions.update");
    expect(entries).toMatchObject([
      {
        outcome: "ok",
        personId: principal.person!.id,
        clientId: principal.client.id,
      },
    ]);
  });

  it("are kept across restarts, so the household's answer stays", async () => {
    const first = await testCore({ apps: [roomsApp()] });
    const { principal } = await signedIn(first);
    await first.apps.setPermission({
      principal,
      appId: "test.rooms",
      permission: "people.read",
      granted: false,
    });

    const again = await testCore({
      apps: [roomsApp()],
      dataDir: first.dataDir,
    });

    expect(
      again.apps.list().find((app) => app.id === "test.rooms")!.permissions,
    ).toEqual(["places.read"]);
  });

  it("only answer what an app asks for", async () => {
    const core = await testCore({ apps: [roomsApp()] });
    const { principal } = await signedIn(core);

    await expect(
      core.apps.setPermission({
        principal,
        appId: "test.rooms",
        permission: "devices.control:light",
        granted: true,
      }),
    ).rejects.toThrow(ActionCallError);
    expect(
      core.apps.list().find((app) => app.id === "test.rooms")!.permissions,
    ).toEqual(["places.read", "people.read"]);
  });
});

describe("an app's jobs", () => {
  it("need no permission, since they touch only its own actions", async () => {
    const core = await testCore({ apps: [roomsApp()] });
    const { maya } = await signedIn(core);

    expect(await run(core, maya.token, "rooms.tidy")).toEqual({
      scheduled: true,
    });
  });
});
