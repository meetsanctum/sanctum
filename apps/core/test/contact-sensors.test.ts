import { describe, expect, it } from "vitest";

import { command, lampsCore, radio, settled } from "./devices-support.js";
import { get, post, type TestCore } from "./support.js";

// Contact sensors: whether what one sits on is open is a `contact`
// capability, which takes no commands and which history records; its
// battery is the device's.

const minute = 60_000;

async function contactCore() {
  const home = await lampsCore();
  await radio.add("contact-1", "contact", "Contact sensor");
  await settled();
  const devices = (
    await get(home.core, "/api/devices", { token: home.maya.token })
  ).json();
  const sensor = devices.find(
    (device: { driverName: string }) => device.driverName === "Contact sensor",
  );
  return { ...home, sensor: sensor.id as string };
}

function deviceOf(core: TestCore, token: string, id: string) {
  return get(core, "/api/devices", { token })
    .then((answer) => answer.json())
    .then((devices) => devices.find((each: { id: string }) => each.id === id));
}

describe("a contact sensor", () => {
  it("comes in as one, with whether it is open and its battery", async () => {
    const { core, maya, sensor } = await contactCore();

    expect(await deviceOf(core, maya.token, sensor)).toMatchObject({
      type: "contact",
      name: "Contact Sensor",
      battery: 95,
      capabilities: [
        {
          id: "contact",
          kind: "contact",
          features: {},
          state: { open: false },
          sync: "synced",
        },
      ],
    });
  });

  it("is named after its room, as any device is", async () => {
    const { core, maya, sensor } = await contactCore();
    const hall = (
      await post(core, "/api/places/rooms/add", { name: "Hall" }, maya)
    ).json();
    await post(
      core,
      "/api/devices/update",
      { id: sensor, roomId: hall.id },
      maya,
    );

    expect(await deviceOf(core, maya.token, sensor)).toMatchObject({
      name: "Hall Contact Sensor",
      roomId: hall.id,
    });
  });

  it("is one from then on when its driver first says its contact, without joining again", async () => {
    const { core, maya } = await lampsCore();
    const hall = (
      await post(core, "/api/places/rooms/add", { name: "Hall" }, maya)
    ).json();
    // A driver that knew nothing of contacts brought it with no parts.
    const registration = {
      key: "magnet-1",
      name: "Door and window sensor",
      model: "MCCGQ11LM",
      type: "unknown",
      capabilities: [],
    };
    core.devices.register("test.lamps", registration);
    const byDriverName = async () =>
      (await get(core, "/api/devices", { token: maya.token }))
        .json()
        .find(
          (device: { driverName: string }) =>
            device.driverName === "Door and window sensor",
        );
    const before = await byDriverName();
    expect(before).toMatchObject({ type: "unknown", name: "Unknown Device" });
    await post(
      core,
      "/api/devices/update",
      { id: before.id, roomId: hall.id },
      maya,
    );

    core.devices.register("test.lamps", {
      ...registration,
      type: "contact",
      capabilities: [{ id: "contact", kind: "contact" }],
    });

    // The same device, in its room, waiting for its first reading.
    expect(await byDriverName()).toMatchObject({
      id: before.id,
      type: "contact",
      name: "Hall Contact Sensor",
      roomId: hall.id,
      capabilities: [{ id: "contact", kind: "contact", state: null }],
    });

    core.devices.report("test.lamps", {
      key: "magnet-1",
      availability: "online",
      states: { contact: { open: true } },
    });
    await settled();
    expect((await byDriverName()).capabilities[0].state).toEqual({
      open: true,
    });
  });

  it("says when it opened, and not again while it says the same", async () => {
    const { core, maya, sensor } = await contactCore();
    core.advance(2 * minute);
    await radio.press("contact-1", { open: true });
    await settled();
    const opened = await deviceOf(core, maya.token, sensor);
    expect(opened.capabilities[0]).toMatchObject({
      state: { open: true },
      changedAt: core.now().toISOString(),
    });

    core.advance(minute);
    await radio.press("contact-1", { open: true, battery: 94 });
    await settled();
    expect(await deviceOf(core, maya.token, sensor)).toMatchObject({
      battery: 94,
      capabilities: [{ changedAt: opened.capabilities[0].changedAt }],
    });
  });

  it("takes no commands", async () => {
    const { core, maya, sensor } = await contactCore();
    const answer = await command(core, maya.token, sensor, "contact", {
      open: true,
    });

    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toMatchObject({ error: "invalid_request" });
    expect(radio.received).toEqual([]);
  });

  it("has how long it was open recorded and rolled up by history", async () => {
    const { core, maya, sensor } = await contactCore();
    const noon = core.now().getTime();
    core.advance(2 * minute);
    await radio.press("contact-1", { open: true });
    await settled();
    core.advance(3 * minute);
    core.history.maintain();

    const params = new URLSearchParams({
      device: sensor,
      capability: "contact",
      from: new Date(noon).toISOString(),
      period: "5m",
    });
    const answer = (
      await get(core, `/api/history/statistics?${params}`, {
        token: maya.token,
      })
    ).json();
    expect(answer.fields.open).toEqual([
      {
        start: new Date(noon).toISOString(),
        mean: 3 / 5,
        min: 0,
        max: 1,
        seconds: 300,
      },
    ]);
  });

  it("refuses a state that does not say open or closed", async () => {
    const { core } = await contactCore();
    expect(() =>
      core.devices.report("test.lamps", {
        key: "contact-1",
        states: { contact: { open: "ajar" } },
      }),
    ).toThrow(/contact state/);
  });
});
