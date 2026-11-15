import { describe, expect, it } from "vitest";

import { lampsCore, radio, settled } from "./devices-support.js";
import { get, post, type TestCore } from "./support.js";

// What the household shows a device as: a contact sensor as a door or a
// window, kept as chosen beside what the device is of itself.

async function contactCore() {
  const home = await lampsCore();
  await radio.add("contact-1", "contact", "Contact sensor");
  await settled();
  const hall = (
    await post(home.core, "/api/places/rooms/add", { name: "Hall" }, home.maya)
  ).json();
  const sensor = (
    await get(home.core, "/api/devices", { token: home.maya.token })
  )
    .json()
    .find(
      (device: { driverName: string }) =>
        device.driverName === "Contact sensor",
    );
  await post(
    home.core,
    "/api/devices/update",
    { id: sensor.id, roomId: hall.id },
    home.maya,
  );
  return { ...home, sensor: sensor.id as string, hall: hall.id as string };
}

function deviceOf(core: TestCore, token: string, id: string) {
  return get(core, "/api/devices", { token })
    .then((answer) => answer.json())
    .then((devices) => devices.find((each: { id: string }) => each.id === id));
}

describe("a contact sensor shown as a door or a window", () => {
  it("is a contact sensor until the household says otherwise", async () => {
    const { core, maya, sensor } = await contactCore();
    expect(await deviceOf(core, maya.token, sensor)).toMatchObject({
      type: "contact",
      shownAs: null,
      name: "Hall contact sensor",
    });
  });

  it("is the door or the window it is shown as, named after it, and a contact sensor again", async () => {
    const { core, maya, sensor } = await contactCore();
    const show = (shownAs: string | null) =>
      post(core, "/api/devices/update", { id: sensor, shownAs }, maya);

    const door = await show("door");
    expect(door.statusCode).toBe(200);
    expect(door.json()).toMatchObject({
      type: "door",
      shownAs: "door",
      name: "Hall door",
      // What it is made of stays.
      capabilities: [{ id: "contact", kind: "contact" }],
    });

    expect((await show("window")).json()).toMatchObject({
      type: "window",
      shownAs: "window",
      name: "Hall window",
    });

    expect((await show(null)).json()).toMatchObject({
      type: "contact",
      shownAs: null,
      name: "Hall contact sensor",
    });
  });

  it("keeps a name the household gave it", async () => {
    const { core, maya, sensor } = await contactCore();
    await post(
      core,
      "/api/devices/update",
      { id: sensor, name: "Letterbox" },
      maya,
    );
    expect(
      (
        await post(
          core,
          "/api/devices/update",
          { id: sensor, shownAs: "door" },
          maya,
        )
      ).json(),
    ).toMatchObject({ type: "door", name: "Letterbox" });
  });

  it("takes the choice with a name and a room, as when a device is added", async () => {
    const { core, maya, sensor } = await contactCore();
    const office = (
      await post(core, "/api/places/rooms/add", { name: "Office" }, maya)
    ).json();
    expect(
      (
        await post(
          core,
          "/api/devices/update",
          { id: sensor, roomId: office.id, shownAs: "window" },
          maya,
        )
      ).json(),
    ).toMatchObject({
      type: "window",
      roomId: office.id,
      name: "Office window",
    });
  });

  it("refuses a type its own does not list, and one there is none of", async () => {
    const { core, maya, sensor, lamp } = await contactCore();
    const show = (id: string, shownAs: string) =>
      post(core, "/api/devices/update", { id, shownAs }, maya);

    expect((await show(sensor, "light")).statusCode).toBe(400);
    expect((await show(sensor, "contact")).statusCode).toBe(400);
    expect((await show(sensor, "gate")).statusCode).toBe(400);
    // A light may be shown as nothing else.
    expect((await show(lamp, "door")).statusCode).toBe(400);
    expect((await show("no-such-device", "door")).statusCode).toBe(404);

    expect(await deviceOf(core, maya.token, sensor)).toMatchObject({
      type: "contact",
      shownAs: null,
    });
    expect(await deviceOf(core, maya.token, lamp)).toMatchObject({
      type: "light",
      shownAs: null,
    });
  });

  it("is not a door on its driver's word", async () => {
    const { core, maya } = await contactCore();
    core.devices.register("test.lamps", {
      key: "magnet-1",
      name: "Door and window sensor",
      type: "door",
      capabilities: [{ id: "contact", kind: "contact" }],
    });
    const device = (await get(core, "/api/devices", { token: maya.token }))
      .json()
      .find(
        (each: { driverName: string }) =>
          each.driverName === "Door and window sensor",
      );
    expect(device).toMatchObject({ type: "contact", shownAs: null });
  });

  it("keeps the choice while the device does not fit it, and uses it once it does again", async () => {
    const { core, maya } = await contactCore();
    const registration = {
      key: "magnet-1",
      name: "Door and window sensor",
      capabilities: [{ id: "contact", kind: "contact" as const }],
    };
    core.devices.register("test.lamps", registration);
    const byDriverName = async () =>
      (await get(core, "/api/devices", { token: maya.token }))
        .json()
        .find(
          (each: { driverName: string }) =>
            each.driverName === "Door and window sensor",
        );
    const { id } = await byDriverName();
    await post(core, "/api/devices/update", { id, shownAs: "window" }, maya);
    expect(await byDriverName()).toMatchObject({
      type: "window",
      name: "Window",
    });

    // Its driver brings it without its contact: nothing fits the choice.
    core.devices.register("test.lamps", { ...registration, capabilities: [] });
    expect(await byDriverName()).toMatchObject({
      id,
      type: "unknown",
      shownAs: null,
      name: "Unknown device",
    });

    // And with it again, as when it joins again: the same window.
    core.devices.register("test.lamps", registration);
    expect(await byDriverName()).toMatchObject({
      id,
      type: "window",
      shownAs: "window",
      name: "Window",
    });
  });

  it("says in the activity log what it was shown as", async () => {
    const { core, maya, sensor } = await contactCore();
    const show = (shownAs: string | null) =>
      post(core, "/api/devices/update", { id: sensor, shownAs }, maya);
    await show("door");
    await show(null);

    const page = (
      await get(core, `/api/activity?device=${sensor}`, { token: maya.token })
    ).json();
    expect(
      page.entries
        .filter(
          (entry: { action: string; detail?: Record<string, unknown> }) =>
            entry.action === "device.update" &&
            entry.detail &&
            "shownAs" in entry.detail,
        )
        .map((entry: { detail: unknown }) => entry.detail),
    ).toEqual([
      { shownAs: null, type: "contact" },
      { shownAs: "door", type: "door" },
    ]);
  });
});
