import { describe, expect, it } from "vitest";

import {
  devicesSeenBy,
  lampsCore,
  openLive,
  personWithClient,
  radio,
  settled,
} from "./devices-support.js";
import { get, post, sharedClient, type TestCore } from "./support.js";

// Adding devices, with the lamps driver's pretend radio: the core lets devices
// join every driver that can pair, and follows each device that joins until it
// is ready.

const pairing = async (core: TestCore, token: string) =>
  (await get(core, "/api/devices/pairing", { token })).json();

function entries(core: TestCore, action: string) {
  return core.activity.recent().filter((entry) => entry.action === action);
}

describe("adding devices", () => {
  it("lets devices join for a while and follows each one until it is ready", async () => {
    const { core, maya } = await lampsCore();

    const opened = await post(core, "/api/devices/pairing/open", {}, maya);
    expect(opened.statusCode).toBe(200);
    // Four minutes unless asked otherwise, and since now.
    expect(opened.json()).toEqual({
      until: "2026-10-26T12:04:00.000Z",
      since: "2026-10-26T12:00:00.000Z",
      joined: [],
    });
    expect(radio.pairing).toEqual([
      { seconds: 240, actor: { kind: "user", id: maya.person.id } },
    ]);

    await radio.join("lamp-2", "light", "Desk lamp");
    const desk = (await devicesSeenBy(core, maya.token)).find(
      (device: { driverName: string }) => device.driverName === "Desk lamp",
    );
    expect(await pairing(core, maya.token)).toEqual({
      until: "2026-10-26T12:04:00.000Z",
      joined: [
        {
          driver: "test.lamps",
          key: "lamp-2",
          stage: "ready",
          description: "Desk lamp",
          deviceId: desk.id,
          known: false,
          joinedAt: "2026-10-26T12:00:00.000Z",
        },
      ],
    });
    // Named after what it is, next to the light the home has already.
    expect(desk.name).toBe("Light 2");
    expect(entries(core, "pairing.open")).toMatchObject([
      { outcome: "ok", personId: maya.person.id, clientId: maya.client.id },
    ]);
  });

  it("says when a device cannot be used yet or does not finish joining", async () => {
    const { core, maya } = await lampsCore();
    await post(core, "/api/devices/pairing/open", { seconds: 60 }, maya);

    await radio.join("doorbell-1", "doorbell", "Doorbell");
    await radio.join("lamp-3", "light", "Lamp", "failed");

    expect((await pairing(core, maya.token)).joined).toMatchObject([
      {
        key: "doorbell-1",
        stage: "unsupported",
        description: "Doorbell",
      },
      { key: "lamp-3", stage: "failed", description: null, deviceId: null },
    ]);
    expect(await devicesSeenBy(core, maya.token)).toHaveLength(2);
  });

  it("tells a device that joins again from a new one", async () => {
    const { core, maya, lamp } = await lampsCore();
    await post(core, "/api/devices/pairing/open", {}, maya);

    // As when a lamp the home has is reset and joins again: it is that
    // lamp from the start, so whoever is adding devices sees its name.
    await radio.tell("lamp-1", "joined");
    await radio.tell("lamp-1", "interviewing");
    expect((await pairing(core, maya.token)).joined).toMatchObject([
      { key: "lamp-1", stage: "interviewing", deviceId: lamp, known: true },
    ]);
    await radio.join("lamp-1", "light", "Kitchen lamp");

    expect((await pairing(core, maya.token)).joined).toMatchObject([
      { key: "lamp-1", stage: "ready", deviceId: lamp, known: true },
    ]);
  });

  it("no longer names a device that joined once the core removes it", async () => {
    const { core, maya, lamp } = await lampsCore();
    await post(core, "/api/devices/pairing/open", {}, maya);
    // A lamp the home has joins again, then is removed.
    await radio.join("lamp-1", "light", "Kitchen lamp");
    const live = await openLive(core, maya.token);

    await post(core, "/api/devices/remove", { id: lamp }, maya);

    const gone = { key: "lamp-1", deviceId: null, known: false };
    expect((await pairing(core, maya.token)).joined).toMatchObject([
      { ...gone, stage: "ready" },
    ]);
    expect(live.messages).toContainEqual({
      type: "pairing",
      pairing: expect.objectContaining({
        joined: [expect.objectContaining(gone)],
      }),
    });
  });

  it("follows only devices that join while someone is adding devices", async () => {
    const { core, maya } = await lampsCore();

    await radio.join("lamp-2", "light", "Desk lamp");
    expect((await pairing(core, maya.token)).joined).toEqual([]);

    // One that joined meanwhile is followed after the time is up.
    await post(core, "/api/devices/pairing/open", {}, maya);
    await radio.tell("lamp-4", "joined");
    await post(core, "/api/devices/pairing/close", {}, maya);
    await radio.tell("lamp-4", "interviewing");
    expect((await pairing(core, maya.token)).joined).toMatchObject([
      { key: "lamp-4", stage: "interviewing" },
    ]);
  });

  it("stops when asked, or once the time is up", async () => {
    const { core, maya } = await lampsCore();
    await post(core, "/api/devices/pairing/open", {}, maya);

    const closed = await post(core, "/api/devices/pairing/close", {}, maya);
    expect(closed.json()).toEqual({ until: null, joined: [] });
    expect(radio.pairing.at(-1)).toEqual({
      seconds: 0,
      actor: { kind: "user", id: maya.person.id },
    });

    radio.windowMs = 20;
    const live = await openLive(core, maya.token);
    await post(core, "/api/devices/pairing/open", {}, maya);
    expect((await pairing(core, maya.token)).until).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await pairing(core, maya.token)).until).toBeNull();
    expect(live.messages.filter((each) => each.type === "pairing")).toEqual([
      {
        type: "pairing",
        pairing: { until: "2026-10-26T12:00:00.020Z", joined: [] },
      },
      { type: "pairing", pairing: { until: null, joined: [] } },
    ]);
  });

  it("fails when no driver lets devices join", async () => {
    const { core, maya } = await lampsCore();
    radio.refusesToOpen = true;

    const opened = await post(core, "/api/devices/pairing/open", {}, maya);

    expect(opened.statusCode).toBe(500);
    expect(opened.json()).toEqual({ error: "app_failed" });
    expect((await pairing(core, maya.token)).until).toBeNull();
    expect(entries(core, "pairing.open")).toMatchObject([
      { outcome: "failed", reason: "app_failed" },
    ]);
    expect(core.logs).toContain(
      "devices: test.lamps did not open (app_failed)",
    );
  });

  it("is for every client, shared ones too, and they all hear of it", async () => {
    const { core } = await lampsCore();
    const ben = personWithClient(core);
    const tablet = sharedClient(core);
    const bensLive = await openLive(core, ben.token);
    const tabletsLive = await openLive(core, tablet.token);

    const opened = await post(
      core,
      "/api/devices/pairing/open",
      {},
      { token: tablet.token },
    );
    const read = await get(core, "/api/devices/pairing", { token: ben.token });
    await radio.join("lamp-2", "light", "Desk lamp");
    await settled();

    expect(opened.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    expect(entries(core, "pairing.open")).toEqual([
      expect.objectContaining({
        outcome: "ok",
        personId: null,
        clientId: tablet.id,
      }),
    ]);
    const pairingMessages = (messages: { type: string }[]) =>
      messages.filter((each) => each.type === "pairing");
    expect(pairingMessages(bensLive.messages).length).toBeGreaterThan(0);
    expect(pairingMessages(tabletsLive.messages).length).toBeGreaterThan(0);
  });

  it("refuses what it cannot take", async () => {
    const { core, maya } = await lampsCore();

    for (const seconds of [0, 255, 1.5]) {
      const refused = await post(
        core,
        "/api/devices/pairing/open",
        { seconds },
        maya,
      );
      expect(refused.statusCode).toBe(400);
    }
    await post(core, "/api/devices/pairing/open", {}, maya);
    await expect(radio.tell("lamp-5", "asleep")).rejects.toThrow(
      /joining device the core cannot take/,
    );
  });
});
