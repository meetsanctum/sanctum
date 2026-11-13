import { describe, expect, it } from "vitest";

import { deviceType } from "../src/devices/classification.js";
import { automaticName, baseName } from "../src/devices/naming.js";
import {
  devicesSeenBy,
  lampsCore,
  openLive,
  radio,
} from "./devices-support.js";
import { post, type TestCore } from "./support.js";

// What a device is and what it is called until the household names it.

describe("what a device is", () => {
  const light = { kind: "light" } as const;
  const power = { kind: "switch" } as const;

  it("is a light if any of it is one, then a switch", () => {
    expect(
      deviceType({
        driverName: "Bulb",
        model: null,
        capabilities: [power, light],
      }),
    ).toBe("light");
    expect(
      deviceType({ driverName: "Relay", model: null, capabilities: [power] }),
    ).toBe("switch");
    expect(
      deviceType({ driverName: "Remote", model: null, capabilities: [] }),
    ).toBe("unknown");
  });

  it("is a sensor when all it has are readings, and a button before that", () => {
    const reading = { kind: "sensor" } as const;
    expect(
      deviceType({
        driverName: "Climate sensor",
        model: null,
        capabilities: [reading, reading],
      }),
    ).toBe("sensor");
    expect(
      deviceType({
        driverName: "Remote",
        model: null,
        capabilities: [{ kind: "button" }, reading],
      }),
    ).toBe("button");
  });

  it("is a plug when its driver calls it one", () => {
    for (const [driverName, model] of [
      ["Smart plug", null],
      ["TRADFRI control outlet", "E1603"],
      ["Wall switch", "Socket SP 120"],
    ] as const) {
      expect(deviceType({ driverName, model, capabilities: [power] })).toBe(
        "plug",
      );
    }
    // Only a whole word says so.
    expect(
      deviceType({
        driverName: "Unplugged relay",
        model: null,
        capabilities: [power],
      }),
    ).toBe("switch");
  });
});

describe("an automatic name", () => {
  it("is the room and what the device is, or just what it is", () => {
    expect(baseName("light", "Office")).toBe("Office light");
    expect(baseName("plug", null)).toBe("Plug");
    expect(baseName("unknown", "Hall")).toBe("Hall device");
  });

  it("is numbered from 2 when another device has it, whatever its case or spacing", () => {
    expect(automaticName("Office light", [])).toBe("Office light");
    expect(automaticName("Office light", ["office  light"])).toBe(
      "Office light 2",
    );
    expect(
      automaticName("Office light", ["Office light", "Office light 2"]),
    ).toBe("Office light 3");
  });

  it("keeps a number that is still free, and drops one that is not its own", () => {
    expect(automaticName("Office light", [], "Office light 3")).toBe(
      "Office light 3",
    );
    expect(
      automaticName("Office light", ["Office light 3"], "Office light 3"),
    ).toBe("Office light");
    expect(automaticName("Office light", [], "Hall light 2")).toBe(
      "Office light",
    );
    expect(automaticName("Office light", [], "Office light 1")).toBe(
      "Office light",
    );
    expect(automaticName("Office light", [], "office light 3")).toBe(
      "Office light 3",
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
      "Office light 2",
      "Plug",
      "Office light",
    ]);

    const live = await openLive(core, maya.token);
    await post(
      core,
      "/api/places/rooms/update",
      { id: office.id, name: "Study" },
      maya,
    );
    expect(await names(core, maya.token)).toEqual([
      "Study light 2",
      "Plug",
      "Study light",
    ]);
    expect(live.messages).toContainEqual(
      expect.objectContaining({
        type: "device",
        id: desk,
        device: expect.objectContaining({ name: "Study light 2" }),
      }),
    );

    // Removing the first leaves the second its number.
    await post(core, "/api/devices/remove", { id: lamp }, maya);
    expect(await names(core, maya.token)).toEqual(["Study light 2", "Plug"]);

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
    expect(named.json().name).toBe("Office light");
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
