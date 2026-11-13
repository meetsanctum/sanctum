import { capabilityKinds } from "@meetsanctum/app-sdk";
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

  it("is what its driver says, when it has the kinds that type needs", () => {
    // A plug its driver's name does not give away.
    expect(
      deviceType({
        driverName: "Relay",
        model: null,
        declaredType: "plug",
        capabilities: [power],
      }),
    ).toBe("plug");
    // The driver's word goes before the order of the types,
    expect(
      deviceType({
        driverName: "Bulb",
        model: null,
        declaredType: "switch",
        capabilities: [power, light],
      }),
    ).toBe("switch");
    // and before what it calls the device.
    expect(
      deviceType({
        driverName: "Smart plug",
        model: null,
        declaredType: "switch",
        capabilities: [power],
      }),
    ).toBe("switch");
  });

  it("is worked out when the driver's type does not fit, is not known or is not said", () => {
    expect(
      deviceType({
        driverName: "Climate sensor",
        model: null,
        declaredType: "light",
        capabilities: [{ kind: "sensor" }],
      }),
    ).toBe("sensor");
    for (const declaredType of ["light", "curtain", null, undefined]) {
      expect(
        deviceType({
          driverName: "Smart plug",
          model: null,
          declaredType,
          capabilities: [power],
        }),
        String(declaredType),
      ).toBe("plug");
    }
  });
});

describe("a driver that says what its device is", () => {
  const relay = async (core: TestCore, token: string) => {
    const { type, name } = (await devicesSeenBy(core, token)).find(
      (device: { driverName: string }) => device.driverName === "Relay",
    );
    return { type, name };
  };

  it("is taken at its word, until it says nothing again", async () => {
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

  it("is not, for a type its device does not fit or the core does not know", async () => {
    const { core, maya } = await lampsCore();

    await radio.add("relay-1", "switch", "Relay", "light");
    expect((await relay(core, maya.token)).type).toBe("plug");

    await radio.add("relay-1", "switch", "Relay", "curtain");
    expect((await relay(core, maya.token)).type).toBe("plug");
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
      name: "Unknown device",
      driverName: "STARKVIND",
      type: "unknown",
      capabilities: [],
      roomId: null,
      probe: false,
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
      ["Unknown device 2", null],
      ["Unknown device", hall.id],
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
    expect(before.name).toBe("Unknown device");

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

describe("an automatic name", () => {
  it("is the room and what the device is, or just what it is", () => {
    expect(baseName("light", "Office")).toBe("Office light");
    expect(baseName("plug", null)).toBe("Plug");
    // What Sanctum cannot use is an unknown device wherever it is.
    expect(baseName("unknown", "Hall")).toBe("Unknown device");
    expect(baseName("unknown", null)).toBe("Unknown device");
    expect(baseName("motion", null)).toBe("Motion sensor");
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
