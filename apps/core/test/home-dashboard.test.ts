import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { lampsCore, openLive, radio, settled } from "./devices-support.js";
import { get, post, sharedClient, testCore, type TestCore } from "./support.js";

// What is on Home: the household's, from every client. A light is on it from
// when it joins, last in its room; anything else once someone adds it, and what
// someone takes off stays off.

async function homeOf(core: TestCore, token: string) {
  const dashboards = (await get(core, "/api/dashboards", { token })).json();
  return dashboards.find(
    (dashboard: { kind: string }) => dashboard.kind === "home",
  );
}

const onHome = async (core: TestCore, token: string) =>
  (await homeOf(core, token)).devices;

function entries(core: TestCore) {
  return core.activity
    .recent()
    .filter((entry) => entry.source === "dashboards");
}

describe("Home", () => {
  it("has the home's lights from when they join, and nothing else by itself", async () => {
    const { core, maya, lamp } = await lampsCore();

    const first = await onHome(core, maya.token);
    await radio.add("lamp-2", "light", "Hall lamp");
    await radio.add("sensor-1", "sensor", "Hall sensor");
    await settled();
    const hallLamp = core.devices
      .list()
      .find((device) => device.driverName === "Hall lamp")!.id;

    // The plug is a switch, so it waits to be added.
    expect(first).toEqual([lamp]);
    expect(await onHome(core, maya.token)).toEqual([lamp, hallLamp]);
    // Nobody did it, so nothing is recorded.
    expect(entries(core)).toEqual([]);
  });

  it("has a device added and taken off, each once in the activity log", async () => {
    const { core, maya, lamp, plug } = await lampsCore();
    const kitchen = sharedClient(core);

    const added = await post(
      core,
      "/api/dashboards/home/add",
      { device: plug },
      kitchen,
    );
    const again = await post(
      core,
      "/api/dashboards/home/add",
      { device: plug },
      maya,
    );
    const removed = await post(
      core,
      "/api/dashboards/home/remove",
      { device: lamp },
      maya,
    );
    const removedAgain = await post(
      core,
      "/api/dashboards/home/remove",
      { device: lamp },
      maya,
    );

    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ kind: "home", devices: [lamp, plug] });
    expect(again.json().devices).toEqual([lamp, plug]);
    expect(removed.json().devices).toEqual([plug]);
    expect(removedAgain.json().devices).toEqual([plug]);
    expect(
      entries(core).map((entry) => [
        entry.action,
        entry.subjectId,
        entry.clientId,
        entry.detail,
      ]),
    ).toEqual([
      ["device.home.remove", lamp, maya.client.id, { dashboard: "Home" }],
      ["device.home.add", plug, kitchen.id, { dashboard: "Home" }],
    ]);
  });

  it("keeps a light taken off off, through a restart and its driver registering it again", async () => {
    const { core, maya, lamp } = await lampsCore();
    await post(core, "/api/dashboards/home/remove", { device: lamp }, maya);

    await radio.add("lamp-1", "light", "Kitchen lamp");
    await settled();
    const next = await testCore({ dataDir: core.dataDir });

    expect(await onHome(core, maya.token)).toEqual([]);
    expect(next.dashboards.list()[0]).toMatchObject({ devices: [] });
  });

  it("is ordered by the household, each device keeping its room", async () => {
    const { core, maya, lamp, plug } = await lampsCore();
    await radio.add("lamp-2", "light", "Hall lamp");
    await settled();
    const hallLamp = core.devices
      .list()
      .find((device) => device.driverName === "Hall lamp")!.id;
    await post(core, "/api/dashboards/home/add", { device: plug }, maya);

    // The lamp and the plug swap the places they had; the hall lamp stays
    // between them.
    const ordered = await post(
      core,
      "/api/dashboards/home/order",
      { devices: [plug, lamp] },
      maya,
    );
    const again = await post(
      core,
      "/api/dashboards/home/order",
      { devices: [lamp, plug] },
      maya,
    );
    const { id: hall } = (
      await post(core, "/api/places/rooms/add", { name: "Hall" }, maya)
    ).json();
    // Moved to another room, the lamp goes last there.
    await post(core, "/api/devices/update", { id: lamp, roomId: hall }, maya);

    expect(ordered.json().devices).toEqual([plug, hallLamp, lamp]);
    expect(again.json().devices).toEqual([lamp, hallLamp, plug]);
    expect(await onHome(core, maya.token)).toEqual([hallLamp, plug, lamp]);
    // Reordering in one go makes one entry.
    expect(
      entries(core)
        .filter((entry) => entry.action === "dashboard.order")
        .map((entry) => [entry.subjectId, entry.count]),
    ).toEqual([[(await homeOf(core, maya.token)).id, 2]]);
  });

  it("puts devices from a removed room after devices already without a room", async () => {
    const { core, maya, lamp } = await lampsCore();
    const { id: room } = (
      await post(core, "/api/places/rooms/add", { name: "Office" }, maya)
    ).json();
    await post(core, "/api/devices/update", { id: lamp, roomId: room }, maya);
    await radio.add("lamp-2", "light", "Loose lamp");
    await settled();
    const loose = core.devices
      .list()
      .find((device) => device.driverName === "Loose lamp")!.id;
    expect(await onHome(core, maya.token)).toEqual([lamp, loose]);

    await post(core, "/api/places/rooms/remove", { id: room }, maya);

    expect(await onHome(core, maya.token)).toEqual([loose, lamp]);
  });

  it("loses a device removed from the home", async () => {
    const { core, maya, lamp } = await lampsCore();

    const live = await openLive(core, sharedClient(core).token);
    try {
      await post(core, "/api/devices/remove", { id: lamp }, maya);
      expect(await onHome(core, maya.token)).toEqual([]);
      await vi.waitFor(() =>
        expect(live.messages).toContainEqual({
          type: "dashboards",
          dashboards: [expect.objectContaining({ devices: [] })],
        }),
      );
    } finally {
      live.socket.terminate();
    }
  });

  it("is the first dashboard of a core from before it, with its lights", async () => {
    const { core, maya, lamp } = await lampsCore();
    await post(core, "/api/dashboards/add", { name: "Kitchen" }, maya);
    core.db.run(sql`UPDATE dashboards SET kind = 'custom'`);
    core.db.run(sql`DELETE FROM home_devices`);

    const next = await testCore({ dataDir: core.dataDir });

    expect(next.dashboards.list()).toEqual([
      expect.objectContaining({ name: "Home", kind: "home", devices: [lamp] }),
      expect.objectContaining({ name: "Kitchen", kind: "custom" }),
    ]);
  });

  it("refuses what does not exist and what is malformed", async () => {
    const { core, maya, lamp, plug } = await lampsCore();

    for (const [url, body, status, error] of [
      ["/api/dashboards/home/add", { device: "nowhere" }, 404, "not_found"],
      ["/api/dashboards/home/add", {}, 400],
      ["/api/dashboards/home/remove", { device: "" }, 400],
      ["/api/dashboards/home/order", { devices: [] }, 400],
      ["/api/dashboards/home/order", { devices: [lamp, lamp] }, 400],
      ["/api/dashboards/home/order", { devices: [plug] }, 409, "not_on_home"],
      ["/api/dashboards/home/order", { devices: ["nowhere"] }, 409],
    ] as const) {
      const answer = await post(core, url, body, maya);
      expect(answer.statusCode).toBe(status);
      if (error) expect(answer.json()).toEqual({ error });
    }
    expect(await onHome(core, maya.token)).toEqual([lamp]);
    expect(entries(core)).toEqual([]);
    expect(
      (await post(core, "/api/dashboards/home/add", { device: plug }))
        .statusCode,
    ).toBe(401);
  });

  it("is followed by live clients", async () => {
    const { core, maya, plug } = await lampsCore();
    const live = await openLive(core, sharedClient(core).token);

    await post(core, "/api/dashboards/home/add", { device: plug }, maya);

    await vi.waitFor(() =>
      expect(live.messages).toContainEqual({
        type: "dashboards",
        dashboards: [
          expect.objectContaining({ devices: [expect.any(String), plug] }),
        ],
      }),
    );
    live.socket.terminate();
  });
});
