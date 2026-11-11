import { describe, expect, it } from "vitest";

import {
  attentionOf,
  button,
  capabilities,
  capabilityOf,
  deviceFirmware,
  devicePress,
  deviceRegistration,
  deviceRelease,
  deviceReport,
  light,
  lightMove,
  lowBattery,
  maintenanceOf,
  onBattery,
  pressParts,
  switchCapability,
  type DeviceInfo,
  type FirmwareInfo,
} from "../src/index.js";

// The capability contract: the same state and commands whatever driver
// brings a device.

describe("lights", () => {
  it("report their state in one shape", () => {
    expect(
      light.state.parse({
        on: true,
        brightness: 40,
        colorMode: "temperature",
        colorTemperature: 370,
      }),
    ).toEqual({
      on: true,
      brightness: 40,
      colorMode: "temperature",
      colorTemperature: 370,
    });
    // A driver that names fields its own way is refused.
    expect(light.state.safeParse({ isOn: true }).success).toBe(false);
    expect(light.state.safeParse({ on: true, brightness: 101 }).success).toBe(
      false,
    );
  });

  it("take commands that ask for state", () => {
    expect(
      light.desired(light.command.parse({ on: true, brightness: 60 })),
    ).toEqual({
      on: true,
      brightness: 60,
    });
    expect(
      light.desired(light.command.parse({ colorTemperature: 300 })),
    ).toEqual({
      colorMode: "temperature",
      colorTemperature: 300,
    });
    expect(
      light.desired(light.command.parse({ hue: 120, saturation: 80 })),
    ).toEqual({
      colorMode: "color",
      hue: 120,
      saturation: 80,
    });
  });

  it("refuse commands that ask for nothing or for two colours at once", () => {
    for (const command of [
      {},
      { transitionSeconds: 2 },
      { hue: 120 },
      { hue: 120, saturation: 80, colorTemperature: 300 },
      { on: true, colour: "red" },
    ]) {
      expect(light.command.safeParse(command).success).toBe(false);
    }
  });

  it("carry out only what their features allow", () => {
    const plain = light.features.parse({});
    const tunable = light.features.parse({
      brightness: true,
      colorTemperature: { min: 153, max: 500 },
    });

    expect(light.supports(plain, { on: true })).toBe(true);
    // Dimming to nothing turns any light off.
    expect(light.supports(plain, { brightness: 0 })).toBe(true);
    expect(light.supports(plain, { brightness: 40 })).toBe(false);
    expect(light.supports(tunable, { brightness: 40 })).toBe(true);
    expect(light.supports(tunable, { colorTemperature: 300 })).toBe(true);
    expect(light.supports(tunable, { colorTemperature: 600 })).toBe(false);
    expect(light.supports(tunable, { hue: 120, saturation: 80 })).toBe(false);
  });
});

describe("switches", () => {
  it("are on or off", () => {
    expect(switchCapability.state.parse({ on: false })).toEqual({ on: false });
    expect(switchCapability.desired({ on: true })).toEqual({ on: true });
    expect(
      switchCapability.command.safeParse({ on: true, brightness: 1 }).success,
    ).toBe(false);
  });
});

describe("buttons", () => {
  it("declare their press actions, each once", () => {
    expect(
      button.features.parse({ actions: ["single", "double", "on_press"] }),
    ).toEqual({ actions: ["single", "double", "on_press"], holds: [] });
    for (const actions of [[], ["single", "single"], ["two words"], [""]]) {
      expect(button.features.safeParse({ actions }).success).toBe(false);
    }
  });

  it("say which of their actions are holds, which last until their release", () => {
    expect(
      button.features.parse({
        actions: ["up_press", "up_hold"],
        holds: ["up_hold"],
      }),
    ).toEqual({ actions: ["up_press", "up_hold"], holds: ["up_hold"] });
    expect(
      button.features.safeParse({ actions: ["single"], holds: ["hold"] })
        .success,
    ).toBe(false);
    expect(
      deviceRelease.parse({ key: "0x0017880104e45724", capability: "button" }),
    ).toEqual({ key: "0x0017880104e45724", capability: "button" });
    expect(
      deviceRelease.safeParse({
        key: "remote",
        capability: "button",
        action: "hold",
      }).success,
    ).toBe(false);
  });

  it("name the button and the press of each action", () => {
    expect(pressParts("up_hold")).toEqual({ button: "up", press: "hold" });
    expect(pressParts("button_1_double")).toEqual({
      button: "button_1",
      press: "double",
    });
    expect(pressParts("single")).toEqual({ button: null, press: "single" });
    expect(pressParts("brightness_move_up")).toEqual({
      button: null,
      press: "brightness_move_up",
    });
  });

  it("have no state and take no commands", () => {
    expect(button.state.safeParse({ action: "single" }).success).toBe(false);
    expect(button.command.safeParse({ on: true }).success).toBe(false);
    expect(capabilityOf("button").supports({ actions: ["single"] }, {})).toBe(
      false,
    );
  });

  it("are pressed by one of their actions, by the driver's key", () => {
    expect(
      devicePress.parse({
        key: "0x00158d0006d3f8da",
        capability: "button",
        action: "single",
      }),
    ).toEqual({
      key: "0x00158d0006d3f8da",
      capability: "button",
      action: "single",
    });
    expect(
      devicePress.safeParse({ key: "remote", capability: "button" }).success,
    ).toBe(false);
  });
});

describe("every capability kind", () => {
  it.each(Object.values(capabilities))(
    "$kind has a tier and says whether shared clients may use it",
    (capability) => {
      expect([
        "read",
        "write",
        "destructive",
        "irreversible-external",
      ]).toContain(capability.tier);
    },
  );
});

describe("what a driver says of firmware", () => {
  it("has progress only while an update is under way", () => {
    expect(
      deviceFirmware.parse({ key: "lamp", state: "updating", progress: 34.5 }),
    ).toEqual({
      key: "lamp",
      state: "updating",
      progress: 34.5,
      remainingSeconds: null,
      problem: null,
    });
    expect(
      deviceFirmware.safeParse({ key: "lamp", state: "current", progress: 100 })
        .success,
    ).toBe(false);
    expect(
      deviceFirmware.safeParse({
        key: "lamp",
        state: "updating",
        progress: 101,
      }).success,
    ).toBe(false);
  });
});

describe("registering a device", () => {
  it("names it by the driver's own key and lists its capabilities", () => {
    expect(
      deviceRegistration.parse({
        key: "0x00158d0001a2b3c4",
        name: "Kitchen lamp",
        capabilities: [{ id: "light", kind: "light" }],
      }),
    ).toEqual({
      key: "0x00158d0001a2b3c4",
      name: "Kitchen lamp",
      manufacturer: null,
      model: null,
      capabilities: [
        {
          id: "light",
          kind: "light",
          features: { brightness: false, colorTemperature: null, color: false },
        },
      ],
      // Nothing known of its firmware, and it cannot be asked how it is.
      firmware: null,
      probe: false,
    });
  });

  it("says what its firmware is, and only with whether it can be updated", () => {
    const lamp = {
      key: "lamp",
      name: "Kitchen lamp",
      capabilities: [{ id: "light", kind: "light" }],
    };
    expect(
      deviceRegistration.parse({
        ...lamp,
        firmware: { version: "1.126.9", updatable: true },
        probe: true,
      }),
    ).toMatchObject({
      firmware: { version: "1.126.9", updatable: true, sleeps: false },
      probe: true,
    });
    expect(
      deviceRegistration.parse({ ...lamp, firmware: { updatable: false } })
        .firmware,
    ).toEqual({ version: null, updatable: false, sleeps: false });
    expect(
      deviceRegistration.safeParse({ ...lamp, firmware: { version: "1.0" } })
        .success,
    ).toBe(false);
  });

  it("takes a button with the actions it declares, and none without", () => {
    const remote = { key: "remote", name: "Wireless mini switch" };
    expect(
      deviceRegistration.parse({
        ...remote,
        capabilities: [
          { id: "button", kind: "button", features: { actions: ["single"] } },
        ],
      }).capabilities,
    ).toEqual([
      {
        id: "button",
        kind: "button",
        features: { actions: ["single"], holds: [] },
      },
    ]);
    expect(
      deviceRegistration.safeParse({
        ...remote,
        capabilities: [{ id: "button", kind: "button" }],
      }).success,
    ).toBe(false);
  });

  it("refuses unknown kinds, repeated ids and devices without capabilities", () => {
    const device = { key: "plug", name: "Plug" };
    for (const capabilities of [
      [],
      [{ id: "power", kind: "outlet" }],
      [
        { id: "l1", kind: "switch" },
        { id: "l1", kind: "switch" },
      ],
    ]) {
      expect(
        deviceRegistration.safeParse({ ...device, capabilities }).success,
      ).toBe(false);
    }
  });
});

describe("reporting a device", () => {
  it("says whether it answers, what it reported, or both", () => {
    expect(
      deviceReport.safeParse({ key: "plug", availability: "offline" }).success,
    ).toBe(true);
    expect(
      deviceReport.safeParse({ key: "plug", states: { power: { on: true } } })
        .success,
    ).toBe(true);
    expect(deviceReport.safeParse({ key: "plug" }).success).toBe(false);
  });
});

describe("what needs attention", () => {
  const plug: DeviceInfo = {
    id: "plug",
    name: "Hall plug",
    driver: "sanctum.zigbee",
    manufacturer: null,
    model: null,
    roomId: "hall",
    driverName: "TRADFRI control outlet",
    availability: "online",
    lastSeenAt: null,
    capabilities: [],
    firmware: null,
    probe: true,
    battery: null,
    leftAt: null,
  };

  it("is nothing for a device that answers, in a room", () => {
    expect(attentionOf(plug, true)).toEqual([]);
  });

  it("puts the most pressing first, and leaves a low battery to upkeep", () => {
    expect(
      attentionOf(
        { ...plug, availability: "offline", battery: 8, roomId: null },
        true,
      ),
    ).toEqual(["offline", "room"]);
    expect(attentionOf({ ...plug, battery: 8 }, true)).toEqual([]);
  });

  it("says only that one its network no longer has left", () => {
    expect(
      attentionOf(
        {
          ...plug,
          availability: "offline",
          battery: 5,
          roomId: null,
          leftAt: "2026-10-31T12:00:00.000Z",
        },
        true,
      ),
    ).toEqual(["left"]);
  });

  it("asks for a room only once the home has rooms", () => {
    expect(attentionOf({ ...plug, roomId: null }, false)).toEqual([]);
    expect(attentionOf({ ...plug, roomId: null }, true)).toEqual(["room"]);
  });

  it("never counts a device that sleeps as offline", () => {
    expect(attentionOf({ ...plug, availability: "unknown" }, true)).toEqual([]);
  });
});

describe("a light's move", () => {
  it("goes up or down at a rate, or stops, and asks for no state", () => {
    expect(lightMove.parse({ move: "up", percentPerSecond: 25 })).toEqual({
      move: "up",
      percentPerSecond: 25,
    });
    expect(lightMove.parse({ move: "stop" })).toEqual({ move: "stop" });
    for (const move of [
      { move: "up" },
      { move: "down", percentPerSecond: 0 },
      { move: "stop", percentPerSecond: 25 },
      { move: "sideways", percentPerSecond: 25 },
    ]) {
      expect(lightMove.safeParse(move).success, JSON.stringify(move)).toBe(
        false,
      );
    }
  });
});

describe("what a device needs from the household", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  const hoursAgo = (hours: number) =>
    new Date(now - hours * 60 * 60_000).toISOString();
  const firmware = (changes: Partial<FirmwareInfo> = {}): FirmwareInfo => ({
    version: "1.0",
    updatable: true,
    sleeps: false,
    state: "current",
    progress: null,
    remainingSeconds: null,
    problem: null,
    checkedAt: null,
    startedAt: null,
    endedAt: null,
    ...changes,
  });
  const remote = {
    availability: "online" as const,
    lastSeenAt: hoursAgo(1),
    battery: 64,
    firmware: firmware({ updatable: false, sleeps: true }),
  };

  it("is on a battery once it says its charge, or its driver says it sleeps", () => {
    expect(onBattery(remote)).toBe(true);
    expect(onBattery({ battery: null, firmware: remote.firmware })).toBe(true);
    expect(onBattery({ battery: null, firmware: firmware() })).toBe(false);
    expect(onBattery({ battery: null, firmware: null })).toBe(false);
  });

  it("has a low battery under 10%", () => {
    expect(lowBattery).toBe(10);
    expect(maintenanceOf({ ...remote, battery: 10 }, now)).toBeNull();
    expect(maintenanceOf({ ...remote, battery: 9 }, now)).toBe("battery");
  });

  it("is quiet once nothing knows whether it answers and it has said nothing for a day", () => {
    const unknown = { ...remote, availability: "unknown" as const };
    expect(maintenanceOf({ ...unknown, lastSeenAt: hoursAgo(25) }, now)).toBe(
      "quiet",
    );
    // Quiet comes before its low charge, which it said before it went quiet.
    expect(
      maintenanceOf({ ...unknown, battery: 6, lastSeenAt: hoursAgo(25) }, now),
    ).toBe("quiet");
    // Not for a day yet, never heard from at all, or still answering.
    expect(maintenanceOf({ ...unknown, lastSeenAt: hoursAgo(20) }, now)).toBe(
      null,
    );
    expect(maintenanceOf({ ...unknown, lastSeenAt: null }, now)).toBeNull();
    expect(
      maintenanceOf({ ...remote, lastSeenAt: hoursAgo(48) }, now),
    ).toBeNull();
    // A device on mains that went quiet is offline, not this.
    expect(
      maintenanceOf(
        {
          availability: "unknown",
          lastSeenAt: hoursAgo(48),
          battery: null,
          firmware: firmware(),
        },
        now,
      ),
    ).toBeNull();
  });

  it("needs an update while one is to start, under way, waiting or didn't finish", () => {
    const light = {
      availability: "online" as const,
      lastSeenAt: hoursAgo(0),
      battery: null,
    };
    for (const state of [
      "available",
      "waiting",
      "updating",
      "failed",
    ] as const) {
      expect(
        maintenanceOf({ ...light, firmware: firmware({ state }) }, now),
      ).toBe("update");
    }
    expect(maintenanceOf({ ...light, firmware: firmware() }, now)).toBeNull();
    expect(
      maintenanceOf({ ...light, firmware: firmware({ state: null }) }, now),
    ).toBeNull();
    expect(maintenanceOf({ ...light, firmware: null }, now)).toBeNull();
  });
});
