import {
  capabilityKinds,
  deviceWords,
  type DeviceType,
  type SensorMeasure,
} from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { deviceType } from "../src/devices/classification.js";
import { automaticName, baseName } from "../src/devices/naming.js";
import { deviceCapabilities } from "../src/devices/schema.js";
import {
  devicesSeenBy,
  lampsCore,
  openLive,
  radio,
} from "./devices-support.js";
import { post, type TestCore } from "./support.js";

// What a device is and what it is called until the household names it.

describe("what a device is", () => {
  it("is what its driver said", () => {
    for (const type of ["light", "plug", "switch", "sensor", "unknown"]) {
      expect(deviceType({ declaredType: type }), type).toBe(type);
    }
  });

  it("is unknown when nothing it can be is stored", () => {
    for (const declaredType of [null, "curtain", "door", "window"]) {
      expect(deviceType({ declaredType }), String(declaredType)).toBe(
        "unknown",
      );
    }
  });

  it("is what the household shows it as, where its own type lists it", () => {
    expect(deviceType({ declaredType: "contact", shownAs: "door" })).toBe(
      "door",
    );
    expect(deviceType({ declaredType: "light", shownAs: "door" })).toBe(
      "light",
    );
  });
});

describe("a driver that says what its device is", () => {
  const relay = async (core: TestCore, token: string) => {
    const device = (await devicesSeenBy(core, token)).find(
      (each: { driverName: string }) => each.driverName === "Relay",
    );
    return { type: device?.type, name: device?.name };
  };

  it("is taken at its word, and the device named again when its word changes", async () => {
    const { core, maya } = await lampsCore();

    // The radio's switches are plugs by their model's name.
    await radio.add("relay-1", "switch", "Relay", "switch");
    expect(await relay(core, maya.token)).toEqual({
      type: "switch",
      name: "Switch",
    });

    // The kettle's plug is "Plug" already.
    await radio.add("relay-1", "switch", "Relay");
    expect(await relay(core, maya.token)).toEqual({
      type: "plug",
      name: "Plug 2",
    });
  });

  it("is refused, for a type its device does not fit or the core does not know", async () => {
    const { core, maya } = await lampsCore();

    await expect(
      radio.add("relay-1", "switch", "Relay", "light"),
    ).rejects.toThrow("capabilities do not fit the declared type light");
    // Unknown is a device with nothing Sanctum uses.
    await expect(
      radio.add("relay-1", "switch", "Relay", "unknown"),
    ).rejects.toThrow("capabilities do not fit the declared type unknown");
    for (const type of ["curtain", "door"]) {
      await expect(
        radio.add("relay-1", "switch", "Relay", type),
      ).rejects.toThrow("cannot take");
    }
    expect(await relay(core, maya.token)).toEqual({
      type: undefined,
      name: undefined,
    });

    // Its next registration, with a type that fits, is taken.
    await radio.add("relay-1", "switch", "Relay", "switch");
    expect((await relay(core, maya.token)).type).toBe("switch");
  });
});

describe("a device with no capabilities", () => {
  const purifiers = async (core: TestCore, token: string) =>
    (await devicesSeenBy(core, token)).filter(
      (device: { model: string }) => device.model === "Air purifier",
    );

  it("is the household's as an unknown device, in a room too, and numbered like any", async () => {
    const { core, maya } = await lampsCore();
    const live = await openLive(core, maya.token);
    await radio.add("purifier-1", "purifier", "STARKVIND");

    const [purifier] = await purifiers(core, maya.token);
    expect(purifier).toMatchObject({
      name: "Unknown Device",
      driverName: "STARKVIND",
      type: "unknown",
      capabilities: [],
      roomId: null,
      probe: false,
      identify: false,
    });
    expect(live.messages).toContainEqual(
      expect.objectContaining({
        type: "device",
        id: purifier.id,
        device: expect.objectContaining({ type: "unknown" }),
      }),
    );

    const hall = await (
      await post(core, "/api/places/rooms/add", { name: "Hall" }, maya)
    ).json();
    await post(
      core,
      "/api/devices/update",
      { id: purifier.id, roomId: hall.id },
      maya,
    );
    await radio.add("purifier-2", "purifier", "FÖRNUFTIG");
    expect(
      (await purifiers(core, maya.token)).map(
        (device: { name: string; roomId: string | null }) => [
          device.name,
          device.roomId,
        ],
      ),
    ).toEqual([
      ["Unknown Device 2", null],
      ["Unknown Device", hall.id],
    ]);
  });

  it("is named, put on Home and removed like any device", async () => {
    const { core, maya } = await lampsCore();
    await radio.add("purifier-1", "purifier", "STARKVIND");
    const [purifier] = await purifiers(core, maya.token);

    await post(
      core,
      "/api/devices/update",
      { id: purifier.id, name: "Hall purifier" },
      maya,
    );
    expect((await purifiers(core, maya.token))[0].name).toBe("Hall purifier");

    const home = await (
      await post(
        core,
        "/api/dashboards/home/add",
        { device: purifier.id },
        maya,
      )
    ).json();
    expect(home.devices).toContain(purifier.id);

    await post(core, "/api/devices/remove", { id: purifier.id }, maya);
    expect(await purifiers(core, maya.token)).toEqual([]);
  });

  it("is seen by no app, whatever kinds it may read", async () => {
    const { core } = await lampsCore();
    await radio.add("purifier-1", "purifier", "STARKVIND");
    const everyKind = { kinds: new Set(capabilityKinds) };

    expect(core.devices.list().map((device) => device.type)).toContain(
      "unknown",
    );
    expect(
      core.devices.list(everyKind).map((device) => device.type),
    ).not.toContain("unknown");
  });

  it("becomes what it is once its driver registers it with a capability", async () => {
    const { core, maya } = await lampsCore();
    await radio.add("gadget-1", "purifier", "Relay");
    const before = (await devicesSeenBy(core, maya.token)).find(
      (device: { driverName: string }) => device.driverName === "Relay",
    );
    expect(before.name).toBe("Unknown Device");

    await radio.add("gadget-1", "switch", "Relay");
    const after = (await devicesSeenBy(core, maya.token)).find(
      (device: { driverName: string }) => device.driverName === "Relay",
    );
    // The same device, now a plug by its model's name.
    expect(after).toMatchObject({
      id: before.id,
      type: "plug",
      name: "Plug 2",
    });
  });
});

// A type's words, as for a device that measures nothing.
const words = (type: DeviceType) => deviceWords(type, []);

describe("an automatic name", () => {
  it("is the room and what the device is, or just what it is", () => {
    expect(baseName(words("light"), "Office")).toBe("Office Light");
    expect(baseName(words("plug"), null)).toBe("Plug");
    // What Sanctum cannot use is an unknown device wherever it is.
    expect(baseName(words("unknown"), "Hall")).toBe("Unknown Device");
    expect(baseName(words("unknown"), null)).toBe("Unknown Device");
    expect(baseName(words("motion"), null)).toBe("Motion Sensor");
  });

  it("starts each word with a capital, but keeps a word's own capitals", () => {
    expect(baseName(words("contact"), "living room")).toBe(
      "Living Room Contact Sensor",
    );
    expect(baseName(words("light"), "über den Wolken")).toBe(
      "Über Den Wolken Light",
    );
    expect(baseName(words("plug"), "TV room")).toBe("TV Room Plug");
    expect(baseName(words("switch"), "iPad corner")).toBe("iPad Corner Switch");
    expect(baseName(words("sensor"), "2nd floor")).toBe("2nd Floor Sensor");
  });

  it("finds words beside punctuation and keeps apostrophes within them", () => {
    expect(baseName(words("light"), "(office)")).toBe("(Office) Light");
    expect(baseName(words("contact"), "living-room")).toBe(
      "Living-Room Contact Sensor",
    );
    expect(baseName(words("plug"), "TV-room")).toBe("TV-Room Plug");
    expect(baseName(words("light"), "children’s room")).toBe(
      "Children’s Room Light",
    );
    expect(baseName(words("switch"), "iPad's corner")).toBe(
      "iPad's Corner Switch",
    );
    expect(baseName(words("light"), "🛋living room")).toBe("🛋Living Room Light");
  });

  it("follows the capitals of a name a device was given before", () => {
    expect(automaticName("Office Light", [], "Office light 2")).toBe(
      "Office Light 2",
    );
    expect(
      automaticName("Office Light", ["Office light 2"], "Office light"),
    ).toBe("Office Light");
  });

  it("is numbered from 2 when another device has it, whatever its case or spacing", () => {
    expect(automaticName("Office Light", [])).toBe("Office Light");
    expect(automaticName("Office Light", ["office  light"])).toBe(
      "Office Light 2",
    );
    expect(
      automaticName("Office Light", ["Office Light", "Office Light 2"]),
    ).toBe("Office Light 3");
  });

  it("keeps a number that is still free, and drops one that is not its own", () => {
    expect(automaticName("Office Light", [], "Office Light 3")).toBe(
      "Office Light 3",
    );
    expect(
      automaticName("Office Light", ["Office Light 3"], "Office Light 3"),
    ).toBe("Office Light");
    expect(automaticName("Office Light", [], "Hall Light 2")).toBe(
      "Office Light",
    );
    expect(automaticName("Office Light", [], "Office Light 1")).toBe(
      "Office Light",
    );
    expect(automaticName("Office Light", [], "office light 3")).toBe(
      "Office Light 3",
    );
  });
});

describe("devices the household has not named", () => {
  async function roomNamed(core: TestCore, maya: object, name: string) {
    return (await post(core, "/api/places/rooms/add", { name }, maya)).json();
  }

  const names = async (core: TestCore, token: string) =>
    (await devicesSeenBy(core, token)).map(
      (device: { name: string }) => device.name,
    );

  it("are named after their room, and follow it", async () => {
    const { core, maya, lamp } = await lampsCore();
    const office = await roomNamed(core, maya, "Office");
    await radio.add("lamp-2", "light", "Desk lamp");
    const desk = (await devicesSeenBy(core, maya.token)).find(
      (device: { driverName: string }) => device.driverName === "Desk lamp",
    ).id;

    await post(
      core,
      "/api/devices/update",
      { id: lamp, roomId: office.id },
      maya,
    );
    await post(
      core,
      "/api/devices/update",
      { id: desk, roomId: office.id },
      maya,
    );
    // Desk lamp, Kettle plug, Kitchen lamp
    expect(await names(core, maya.token)).toEqual([
      "Office Light 2",
      "Plug",
      "Office Light",
    ]);

    const live = await openLive(core, maya.token);
    await post(
      core,
      "/api/places/rooms/update",
      { id: office.id, name: "Study" },
      maya,
    );
    expect(await names(core, maya.token)).toEqual([
      "Study Light 2",
      "Plug",
      "Study Light",
    ]);
    expect(live.messages).toContainEqual(
      expect.objectContaining({
        type: "device",
        id: desk,
        device: expect.objectContaining({ name: "Study Light 2" }),
      }),
    );

    // Removing the first leaves the second its number.
    await post(core, "/api/devices/remove", { id: lamp }, maya);
    expect(await names(core, maya.token)).toEqual(["Study Light 2", "Plug"]);

    // A removed room leaves them in no room, named after what they are.
    await post(core, "/api/places/rooms/remove", { id: office.id }, maya);
    expect(await names(core, maya.token)).toEqual(["Light", "Plug"]);
  });

  it("keep a name the household gives them, until it is taken back", async () => {
    const { core, maya, lamp } = await lampsCore();
    const office = await roomNamed(core, maya, "Office");

    await post(
      core,
      "/api/devices/update",
      { id: lamp, name: "  Focus lamp  " },
      maya,
    );
    await post(
      core,
      "/api/devices/update",
      { id: lamp, roomId: office.id },
      maya,
    );
    expect(await names(core, maya.token)).toEqual(["Plug", "Focus lamp"]);

    const named = await post(
      core,
      "/api/devices/update",
      { id: lamp, name: null },
      maya,
    );
    expect(named.json().name).toBe("Office Light");
  });

  it("are not named after another device's own name", async () => {
    const { core, maya, plug } = await lampsCore();

    await post(
      core,
      "/api/devices/update",
      { id: plug, name: "Light 2" },
      maya,
    );
    await radio.add("lamp-2", "light", "Desk lamp");

    expect(await names(core, maya.token)).toEqual([
      "Light 3",
      "Light 2",
      "Light",
    ]);
  });
});

describe("a sensor's automatic name", () => {
  const sensorOf = (key: string, measures: readonly SensorMeasure[]) => ({
    key,
    name: key,
    type: "sensor",
    capabilities: measures.map((measure) => ({
      id: measure,
      kind: "sensor",
      features: { measures: measure },
    })),
  });
  const nameOf = async (core: TestCore, token: string, key: string) =>
    (await devicesSeenBy(core, token)).find(
      (device: { driverName: string }) => device.driverName === key,
    )?.name;

  it("says what it measures, one thing by its own words and several as an environment sensor", async () => {
    const { core, maya } = await lampsCore();
    core.devices.register("test.lamps", sensorOf("t", ["temperature"]));
    core.devices.register("test.lamps", sensorOf("h", ["humidity"]));
    core.devices.register("test.lamps", sensorOf("l", ["illuminance"]));
    core.devices.register(
      "test.lamps",
      sensorOf("th", ["temperature", "humidity"]),
    );

    expect(await nameOf(core, maya.token, "t")).toBe("Temperature Sensor");
    expect(await nameOf(core, maya.token, "h")).toBe("Humidity Sensor");
    expect(await nameOf(core, maya.token, "l")).toBe("Light Sensor");
    expect(await nameOf(core, maya.token, "th")).toBe("Environment Sensor");
  });

  it("follows its room, and is numbered beside one of the same name", async () => {
    const { core, maya } = await lampsCore();
    const office = (
      await post(core, "/api/places/rooms/add", { name: "Office" }, maya)
    ).json();
    const ids = ["a", "b"].map(
      (key) =>
        core.devices.register("test.lamps", sensorOf(key, ["temperature"])).id,
    );
    for (const id of ids) {
      await post(core, "/api/devices/update", { id, roomId: office.id }, maya);
    }

    expect(await nameOf(core, maya.token, "a")).toBe(
      "Office Temperature Sensor",
    );
    expect(await nameOf(core, maya.token, "b")).toBe(
      "Office Temperature Sensor 2",
    );
  });

  it("numbers a sensor when a device in another room already has its name", async () => {
    const { core, maya } = await lampsCore();
    const [office, officeTemperature] = await Promise.all(
      ["Office", "Office Temperature"].map(async (name) =>
        (await post(core, "/api/places/rooms/add", { name }, maya)).json(),
      ),
    );
    const other = core.devices.register(
      "test.lamps",
      sensorOf("o", ["humidity"]),
    ).id;
    await post(
      core,
      "/api/devices/update",
      {
        id: other,
        roomId: officeTemperature.id,
        name: "Office Temperature Sensor",
      },
      maya,
    );
    const sensor = core.devices.register(
      "test.lamps",
      sensorOf("t", ["temperature"]),
    ).id;
    await post(
      core,
      "/api/devices/update",
      { id: sensor, roomId: office.id },
      maya,
    );

    expect(await nameOf(core, maya.token, "t")).toBe(
      "Office Temperature Sensor 2",
    );
    expect(await nameOf(core, maya.token, "o")).toBe(
      "Office Temperature Sensor",
    );
  });

  it("is a motion sensor's whatever else it measures", async () => {
    const { core, maya } = await lampsCore();
    core.devices.register("test.lamps", {
      key: "m",
      name: "m",
      type: "motion",
      capabilities: [
        { id: "motion", kind: "motion", features: {} },
        { id: "lux", kind: "sensor", features: { measures: "illuminance" } },
      ],
    });
    expect(await nameOf(core, maya.token, "m")).toBe("Motion Sensor");
  });

  it("follows changes in what a sensor measures unless the household names it", async () => {
    const { core, maya } = await lampsCore();
    const { id } = core.devices.register(
      "test.lamps",
      sensorOf("t", ["temperature"]),
    );
    expect(
      core.devices.register("test.lamps", sensorOf("t", ["humidity"])).id,
    ).toBe(id);
    expect(await nameOf(core, maya.token, "t")).toBe("Humidity Sensor");

    await post(core, "/api/devices/update", { id, name: "Desk" }, maya);
    core.devices.register(
      "test.lamps",
      sensorOf("t", ["humidity", "temperature"]),
    );
    expect(await nameOf(core, maya.token, "t")).toBe("Desk");

    await post(core, "/api/devices/update", { id, name: null }, maya);
    expect(await nameOf(core, maya.token, "t")).toBe("Environment Sensor");
  });

  it("is a sensor's when what is stored of its measures doesn't parse", async () => {
    const { core, maya } = await lampsCore();
    const { id } = core.devices.register(
      "test.lamps",
      sensorOf("t", ["temperature"]),
    );
    core.db
      .update(deviceCapabilities)
      .set({ features: { measures: "radiance" } })
      .where(eq(deviceCapabilities.deviceId, id))
      .run();
    const hall = (
      await post(core, "/api/places/rooms/add", { name: "Hall" }, maya)
    ).json();
    await post(core, "/api/devices/update", { id, roomId: hall.id }, maya);

    expect(await nameOf(core, maya.token, "t")).toBe("Hall Sensor");
  });
});
