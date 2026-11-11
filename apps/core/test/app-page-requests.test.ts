import { describe, expect, it } from "vitest";

import { lampsCore, openLive, settled } from "./devices-support.js";
import { get, post, sharedClient } from "./support.js";

// A request from an app's page names its app: the core answers it with what
// both the client and the app may see, and every client hears at once when an
// app's grants change.

const page = { "x-sanctum-app": "test.panel" };

describe("a request from an app's page", () => {
  it("sees only the devices its app reads, and the shell's own sees every one", async () => {
    const { core, maya, lamp, plug } = await lampsCore();

    const own = await get(core, "/api/devices", { token: maya.token });
    expect(own.json().map((device: { id: string }) => device.id)).toEqual(
      expect.arrayContaining([lamp, plug]),
    );
    // The panel reads lights, so the kettle plug, a switch, is out of sight.
    const forPanel = await get(core, "/api/devices", {
      token: maya.token,
      headers: page,
    });
    expect(forPanel.json().map((device: { id: string }) => device.id)).toEqual([
      lamp,
    ]);
  });

  it("reads places only while its app holds places.read", async () => {
    const { core, maya } = await lampsCore();
    expect(
      (await get(core, "/api/places", { token: maya.token, headers: page }))
        .statusCode,
    ).toBe(200);

    await post(
      core,
      "/api/apps/test.panel/permissions/update",
      { permission: "places.read", granted: false },
      maya,
    );
    const refused = await get(core, "/api/places", {
      token: maya.token,
      headers: page,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "forbidden" });
    // The shell itself still reads them.
    expect(
      (await get(core, "/api/places", { token: maya.token })).statusCode,
    ).toBe(200);
  });

  it("commands only a kind its app controls", async () => {
    const { core, maya, lamp, plug } = await lampsCore();

    const light = await post(
      core,
      "/api/devices/command",
      { device: lamp, capability: "light", command: { on: true } },
      { token: maya.token, headers: page },
    );
    expect(light.statusCode).toBe(200);
    await settled();

    const kettle = await post(
      core,
      "/api/devices/command",
      { device: plug, capability: "switch", command: { on: true } },
      { token: maya.token, headers: page },
    );
    expect(kettle.statusCode).toBe(403);
    expect(
      core.activity.page({ subjectId: plug, limit: 20 }).entries,
    ).toContainEqual(
      expect.objectContaining({
        action: "device.command",
        outcome: "refused",
        reason: "forbidden",
        app: "test.panel",
        personId: maya.person.id,
        clientId: maya.client.id,
      }),
    );
  });

  it("sees its app's own entities and the standard types it reads", async () => {
    const { core, maya } = await lampsCore();
    core.entities.publish("test.other", {
      key: "glow",
      type: "other.glow",
      name: "Glow",
      state: {},
    });

    const forPanel = await get(core, "/api/entities", {
      token: maya.token,
      headers: page,
    });
    expect(forPanel.json()).toEqual([]);
    const own = await get(core, "/api/entities", { token: maya.token });
    expect(own.json()).toHaveLength(1);
  });

  it("switches a place's lights only while its app controls lights", async () => {
    const { core, maya } = await lampsCore();
    await post(
      core,
      "/api/apps/test.panel/permissions/update",
      { permission: "devices.control:light", granted: false },
      maya,
    );

    const refused = await post(
      core,
      "/api/devices/lights",
      { place: { kind: "home" }, to: "on" },
      { token: maya.token, headers: page },
    );
    expect(refused.statusCode).toBe(403);
  });

  it("reaches only the routes an app's client uses, and its own app's", async () => {
    const { core, maya, lamp } = await lampsCore();

    // Renaming a device is the shell's, not an app page's.
    const rename = await post(
      core,
      "/api/devices/update",
      { id: lamp, name: "Desk" },
      { token: maya.token, headers: page },
    );
    expect(rename.statusCode).toBe(403);
    // Another app's actions are not its to call.
    const other = await post(
      core,
      "/api/apps/test.lamps/actions/lamps.anything",
      {},
      { token: maya.token, headers: page },
    );
    expect(other.statusCode).toBe(403);
    // Its own are.
    const own = await post(
      core,
      "/api/apps/test.panel/actions/panel.overview",
      {},
      { token: maya.token, headers: page },
    );
    expect(own.statusCode).toBe(200);
  });

  it("names an app that is installed", async () => {
    const { core, maya } = await lampsCore();
    const unknown = await get(core, "/api/devices", {
      token: maya.token,
      headers: { "x-sanctum-app": "test.nope" },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("an app's grants", () => {
  it("reach every live client as they change, as GET /api/apps lists the app", async () => {
    const { core, maya } = await lampsCore();
    const kitchen = sharedClient(core);
    const mine = await openLive(core, maya.token);
    const shared = await openLive(core, kitchen.token);

    const answer = await post(
      core,
      "/api/apps/test.panel/permissions/update",
      { permission: "places.read", granted: false },
      maya,
    );

    for (const live of [mine, shared]) {
      await expect
        .poll(() => live.messages.filter((each) => each.type === "app"))
        .toEqual([{ type: "app", app: answer.json() }]);
    }
    expect(answer.json().permissions).not.toContain("places.read");
  });
});
