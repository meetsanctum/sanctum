import { describe, expect, it } from "vitest";

import {
  command,
  devicesSeenBy,
  lampsCore,
  openLive,
  personWithClient,
  radio,
} from "./devices-support.js";
import { post, sharedClient, type TestCore } from "./support.js";

// Removing a device, with the lamps driver's pretend radio: its driver takes
// it off its network first, then the core forgets it. A device its driver
// cannot remove is kept, unless it is forgotten by force.

function entries(core: TestCore, action: string) {
  return core.activity.recent().filter((entry) => entry.action === action);
}

describe("removing a device", () => {
  it("has its driver take it off its network, then forgets it", async () => {
    const { core, maya, lamp } = await lampsCore();
    const live = await openLive(core, maya.token);

    const removed = await post(core, "/api/devices/remove", { id: lamp }, maya);

    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ id: lamp });
    expect(radio.removals).toEqual([
      {
        removal: { key: "lamp-1", device: lamp, force: false },
        actor: { kind: "user", id: maya.person.id },
      },
    ]);
    expect(
      (await devicesSeenBy(core, maya.token)).map(
        (device: { driverName: string }) => device.driverName,
      ),
    ).toEqual(["Kettle plug"]);
    expect(live.messages).toContainEqual({
      type: "device",
      id: lamp,
      device: null,
    });
    // Its driver no longer had it before the core forgot it: that is no
    // news, so it never showed as offline.
    expect(live.messages).not.toContainEqual(
      expect.objectContaining({
        id: lamp,
        device: expect.objectContaining({ availability: "offline" }),
      }),
    );
    expect(entries(core, "device.remove")).toMatchObject([
      {
        outcome: "ok",
        subjectId: lamp,
        personId: maya.person.id,
        clientId: maya.client.id,
      },
    ]);
  });

  it("keeps the device when its driver cannot remove it, and forgets it by force", async () => {
    const { core, maya, lamp } = await lampsCore();
    await radio.unplug("lamp-1");

    const failed = await post(core, "/api/devices/remove", { id: lamp }, maya);
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "app_failed" });
    expect(await devicesSeenBy(core, maya.token)).toHaveLength(2);

    const forced = await post(
      core,
      "/api/devices/remove",
      { id: lamp, force: true },
      maya,
    );
    expect(forced.statusCode).toBe(200);
    expect(radio.removals.at(-1)!.removal).toEqual({
      key: "lamp-1",
      device: lamp,
      force: true,
    });
    expect(await devicesSeenBy(core, maya.token)).toHaveLength(1);
    expect(
      entries(core, "device.remove")
        .map((entry) => entry.outcome)
        .sort(),
    ).toEqual(["failed", "ok"]);
  });

  it("forgets a device whose driver is not running only by force", async () => {
    const { core, maya, plug } = await lampsCore({ origin: "official" });
    await core.apps.remove("test.lamps");

    const refused = await post(core, "/api/devices/remove", { id: plug }, maya);
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({ error: "unavailable" });

    const forced = await post(
      core,
      "/api/devices/remove",
      { id: plug, force: true },
      maya,
    );
    expect(forced.statusCode).toBe(200);
    expect(await devicesSeenBy(core, maya.token)).toHaveLength(1);
    expect(radio.removals).toEqual([]);
  });

  it("forgets what was asked of it, and it comes back as new if it joins again", async () => {
    const { core, maya, lamp } = await lampsCore({ confirmMs: 30 });
    radio.confirms = false;
    await command(core, maya.token, lamp, "light", { on: true });

    await post(core, "/api/devices/remove", { id: lamp }, maya);
    // No conflict is settled for a device that has gone.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await radio.add("lamp-1", "light", "Kitchen lamp");

    const back = (await devicesSeenBy(core, maya.token)).find(
      (device: { driverName: string }) => device.driverName === "Kitchen lamp",
    );
    expect(back.id).not.toBe(lamp);
    expect(back).toMatchObject({ name: "Light", roomId: null });
    expect(back.capabilities[0]).toMatchObject({ sync: "synced" });
  });

  it("is for every client, shared ones too", async () => {
    const { core, maya, lamp, plug } = await lampsCore();
    const ben = personWithClient(core);
    const tablet = sharedClient(core);

    const byBen = await post(core, "/api/devices/remove", { id: lamp }, ben);
    const byTablet = await post(
      core,
      "/api/devices/remove",
      { id: plug },
      { token: tablet.token },
    );

    expect(byBen.json()).toEqual({ id: lamp });
    expect(byTablet.json()).toEqual({ id: plug });
    expect(await devicesSeenBy(core, maya.token)).toEqual([]);
    expect(
      entries(core, "device.remove").map(({ outcome, clientId }) => ({
        outcome,
        clientId,
      })),
    ).toEqual(
      expect.arrayContaining([
        { outcome: "ok", clientId: ben.client.id },
        { outcome: "ok", clientId: tablet.id },
      ]),
    );
  });

  it("refuses a device that does not exist", async () => {
    const { core, maya } = await lampsCore();

    const missing = await post(
      core,
      "/api/devices/remove",
      { id: "no-such-device" },
      maya,
    );
    expect(missing.statusCode).toBe(404);
    expect((await post(core, "/api/devices/remove", {}, maya)).statusCode).toBe(
      400,
    );
  });
});
