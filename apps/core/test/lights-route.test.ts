import { describe, expect, it } from "vitest";

import { radio, settled } from "./devices-support.js";
import {
  asked,
  darkRoom,
  home,
  lights,
  publishRule,
  switched,
} from "./lights-support.js";
import { get, post, sharedClient } from "./support.js";

describe("POST /api/devices/lights", () => {
  it("toggles a room's lights off while any is on, leaving switches and offline lights alone", async () => {
    const { core, token, living, ids } = await home();
    const response = await lights(core, token, {
      place: { kind: "room", id: living },
      to: "toggle",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ on: false, switched: 1, failed: [] });
    expect(switched()).toEqual([["lamp-1", { on: false }]]);
    const lamp = (await get(core, "/api/devices", { token }))
      .json()
      .find((device: { id: string }) => device.id === ids.lamp);
    expect(lamp.capabilities[0].setBy.actor).toMatchObject({ kind: "user" });
  });

  it("toggles them on when all are off", async () => {
    const { core, token, kitchen } = await home();
    const response = await lights(core, token, {
      place: { kind: "room", id: kitchen },
      to: "toggle",
    });
    expect(response.json()).toEqual({ on: true, switched: 1, failed: [] });
    expect(switched()).toEqual([["counter-1", { on: true }]]);
  });

  it("switches a zone's rooms, or the whole home with lights in no room", async () => {
    const { core, token, downstairs } = await home();
    await lights(core, token, {
      place: { kind: "zone", id: downstairs },
      to: "on",
    });
    expect(switched().sort()).toEqual([
      ["ceiling-1", { on: true }],
      ["counter-1", { on: true }],
    ]);

    radio.received.length = 0;
    const everywhere = await lights(core, token, {
      place: { kind: "home" },
      to: "off",
    });
    expect(everywhere.json()).toMatchObject({ on: false, switched: 4 });
    expect(switched().sort()).toEqual([
      ["ceiling-1", { on: false }],
      ["counter-1", { on: false }],
      ["hall-1", { on: false }],
      ["lamp-1", { on: false }],
    ]);
  });

  it("refuses a room or zone the home does not have, and a request it cannot read", async () => {
    const { core, token } = await home();
    for (const place of [
      { kind: "room", id: "attic" },
      { kind: "zone", id: "upstairs" },
    ]) {
      const response = await lights(core, token, { place, to: "on" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
    }
    for (const body of [
      { place: { kind: "home" }, to: "dim" },
      { place: { kind: "storey", id: "x" }, to: "on" },
      { place: { kind: "home" }, to: "on", extra: true },
    ]) {
      expect((await lights(core, token, body)).statusCode).toBe(400);
    }
    expect(radio.received).toEqual([]);
  });

  it("names the lights that could not be switched", async () => {
    const { core, token, ids } = await home();
    // The counter light has lost its power but not yet gone offline.
    radio.gadgets.get("counter-1")!.answers = false;
    const response = await lights(core, token, {
      place: { kind: "home" },
      to: "on",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      on: true,
      switched: 2,
      failed: [{ device: ids.counter, capability: "light" }],
    });
  });

  it("lets a shared client switch every light, as the household", async () => {
    const { core, living } = await home();
    const tablet = sharedClient(core);
    const response = await lights(core, tablet.token, {
      place: { kind: "room", id: living },
      to: "toggle",
    });
    // The lamp is on, so it turns the room off.
    expect(response.json()).toEqual({ on: false, switched: 1, failed: [] });
    expect(switched()).toEqual([["lamp-1", { on: false }]]);
    expect(radio.received[0]!.actor).toEqual({
      kind: "client",
      id: tablet.id,
    });
  });
});

describe("POST /api/devices/lights with a set", () => {
  it("sets the brightness of the lights that are on, leaving those off alone", async () => {
    const { core, token, living } = await home();
    await radio.add("plain-1", "light", "Plain light", undefined, {
      brightness: false,
      colorTemperature: null,
      color: false,
    });
    const plain = (await get(core, "/api/devices", { token }))
      .json()
      .find(
        (device: { driverName: string }) => device.driverName === "Plain light",
      );
    const assigned = await post(
      core,
      "/api/devices/update",
      { id: plain.id, roomId: living },
      { token },
    );
    expect(assigned.statusCode).toBe(200);
    await radio.press("plain-1", { on: true });
    await settled();
    const response = await lights(core, token, {
      place: { kind: "room", id: living },
      set: { brightness: 40 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ on: true, switched: 1, failed: [] });
    // A brightness above 0 comes with on, as any light's does.
    expect(asked()).toEqual({ "lamp-1": { on: true, brightness: 40 } });
  });

  it("brings a room with none on up at the brightness asked", async () => {
    const { core, token, kitchen } = await home();
    const response = await lights(core, token, {
      place: { kind: "room", id: kitchen },
      set: { brightness: 30 },
    });
    expect(response.json()).toEqual({ on: true, switched: 1, failed: [] });
    expect(asked()).toEqual({ "counter-1": { on: true, brightness: 30 } });
  });

  it.each([
    ["the rule's", 40],
    ["the light's remembered", 25],
  ])(
    "brings even the lights a room's rule keeps off to a colour at %s level",
    async (source, brightness) => {
      const { core, token, living, ids } = await darkRoom();
      await radio.press("ceiling-1", { on: true, brightness: 25 });
      await radio.press("ceiling-1", { on: false });
      await settled();
      await publishRule(core, token, "living", {
        placeId: living,
        lights: [
          { device: ids.lamp, capability: "light", state: { on: false } },
          {
            device: ids.ceiling,
            capability: "light",
            state:
              source === "the rule's"
                ? { on: true, brightness, colorTemperature: 300 }
                : { on: true },
          },
        ],
        until: null,
      });

      const response = await lights(core, token, {
        place: { kind: "room", id: living },
        set: { hue: 200, saturation: 80 },
      });
      expect(response.json()).toEqual({ on: true, switched: 2, failed: [] });
      const command = { on: true, brightness, hue: 200, saturation: 80 };
      expect(asked()).toEqual({ "ceiling-1": command, "lamp-1": command });
    },
  );

  it("leaves the lights that are off alone for a brightness, even where the room's rule would bring them on", async () => {
    const { core, token, living, ids } = await home();
    await publishRule(core, token, "living", {
      placeId: living,
      lights: [
        {
          device: ids.ceiling,
          capability: "light",
          state: { on: true, brightness: 40 },
        },
      ],
      until: null,
    });
    await lights(core, token, {
      place: { kind: "room", id: living },
      set: { brightness: 70 },
    });
    expect(asked()).toEqual({ "lamp-1": { on: true, brightness: 70 } });
  });

  it("turns them off at a brightness of 0", async () => {
    const { core, token, living } = await home();
    const response = await lights(core, token, {
      place: { kind: "room", id: living },
      set: { brightness: 0 },
    });
    expect(response.json()).toEqual({ on: false, switched: 1, failed: [] });
    expect(switched()).toEqual([["lamp-1", { on: false }]]);
  });

  it("brings off lights to a white at the rounded average of the lit lights, within each light's range", async () => {
    const { core, token, living, ids } = await home();
    await post(
      core,
      "/api/devices/update",
      { id: ids.hall, roomId: living },
      { token },
    );
    await radio.press("lamp-1", { on: true, brightness: 35 });
    await radio.press("hall-1", { on: true, brightness: 60 });
    await settled();
    radio.received.length = 0;
    const response = await lights(core, token, {
      place: { kind: "room", id: living },
      set: { colorTemperature: 600 },
    });
    expect(response.json()).toEqual({ on: true, switched: 3, failed: [] });
    expect(asked()).toEqual({
      "lamp-1": { colorTemperature: 500 },
      "hall-1": { colorTemperature: 500 },
      "ceiling-1": { on: true, brightness: 48, colorTemperature: 500 },
    });
  });

  it.each([
    ["no level", undefined],
    ["a retained zero level", 0],
  ])(
    "brings the lights that are off up at full when the only lit light has %s",
    async (_label, brightness) => {
      const { core, token, living } = await darkRoom();
      const plain = { key: "plain-1", name: "Plain light", type: "light" };
      const capability = { id: "light", kind: "light" };
      const { id } = core.devices.register("test.lamps", {
        ...plain,
        capabilities: [capability],
      });
      core.devices.report("test.lamps", {
        key: plain.key,
        availability: "online",
        states: { light: { on: true, brightness } },
      });
      if (brightness === 0) {
        // Re-register with dimming before the light reports a new level.
        core.devices.register("test.lamps", {
          ...plain,
          capabilities: [{ ...capability, features: { brightness: true } }],
        });
      }
      await post(
        core,
        "/api/devices/update",
        { id, roomId: living },
        { token },
      );
      await radio.press("ceiling-1", { on: true, brightness: 25 });
      await radio.press("ceiling-1", { on: false });
      await settled();

      const response = await lights(core, token, {
        place: { kind: "room", id: living },
        set: { hue: 200, saturation: 80 },
      });
      expect(response.json()).toEqual({ on: true, switched: 2, failed: [] });
      const command = { on: true, brightness: 100, hue: 200, saturation: 80 };
      expect(asked()).toEqual({ "lamp-1": command, "ceiling-1": command });
    },
  );

  it("brings a light that only dims on for a white, and leaves it off for a colour", async () => {
    const { core, token, living } = await home();
    await radio.add("plain-1", "light", "Plain light", undefined, {
      brightness: true,
      colorTemperature: null,
      color: false,
    });
    const plain = (await get(core, "/api/devices", { token }))
      .json()
      .find(
        (device: { driverName: string }) => device.driverName === "Plain light",
      );
    await post(
      core,
      "/api/devices/update",
      { id: plain.id, roomId: living },
      { token },
    );
    await radio.press("lamp-1", { on: true, brightness: 50 });
    await settled();
    radio.received.length = 0;
    const place = { kind: "room", id: living };

    await lights(core, token, { place, set: { hue: 200, saturation: 80 } });
    expect(asked()["plain-1"]).toBeUndefined();

    radio.received.length = 0;
    await lights(core, token, { place, set: { colorTemperature: 300 } });
    expect(asked()["plain-1"]).toEqual({ on: true, brightness: 50 });
  });

  it.each([true, false])(
    "sets a colour-only light to white even if it remembers blue (on: %s)",
    async (on) => {
      const { core, token, living } = await home();
      await radio.add("strip-1", "light", "Strip", undefined, {
        brightness: true,
        colorTemperature: null,
        color: true,
      });
      const strip = (await get(core, "/api/devices", { token }))
        .json()
        .find(
          (device: { driverName: string }) => device.driverName === "Strip",
        );
      await post(
        core,
        "/api/devices/update",
        { id: strip.id, roomId: living },
        { token },
      );
      await radio.press("strip-1", {
        on,
        colorMode: "color",
        hue: 220,
        saturation: 100,
      });
      await settled();

      const response = await lights(core, token, {
        place: { kind: "room", id: living },
        set: { colorTemperature: 300 },
      });
      expect(response.json()).toEqual({ on: true, switched: 3, failed: [] });
      expect(asked()["strip-1"]).toEqual({
        ...(!on && { on: true, brightness: 100 }),
        hue: 0,
        saturation: 0,
      });
    },
  );

  it("refuses a set it cannot read", async () => {
    const { core, token, living } = await home();
    const place = { kind: "room", id: living };
    for (const body of [
      { place, set: { brightness: 101 } },
      { place, set: {} },
      { place, set: { hue: 120 } },
      { place, set: { brightness: 50, colorTemperature: 300 } },
      { place, to: "on", set: { brightness: 50 } },
    ]) {
      expect((await lights(core, token, body)).statusCode).toBe(400);
    }
    expect(radio.received).toEqual([]);
  });
});

describe("turning a room on as its lights.turnOn says", () => {
  it("keeps off the lights it keeps off, and brings the others on with their look", async () => {
    const { core, token, living, ids } = await darkRoom();
    await publishRule(core, token, "living", {
      placeId: living,
      lights: [
        { device: ids.lamp, capability: "light", state: { on: false } },
        {
          device: ids.ceiling,
          capability: "light",
          state: { on: true, brightness: 40 },
        },
      ],
      until: null,
    });

    const response = await lights(core, token, {
      place: { kind: "room", id: living },
      to: "toggle",
    });

    expect(response.json()).toEqual({ on: true, switched: 1, failed: [] });
    expect(Object.keys(asked())).toEqual(["ceiling-1"]);
    expect(asked()["ceiling-1"]).toMatchObject({ on: true, brightness: 40 });
  });

  it("goes by the highest-ranked rule for the room, the first app's of those ranked alike", async () => {
    const { core, token, living, ids } = await darkRoom();
    const only = (on: string) =>
      [ids.lamp, ids.ceiling].map((device) => ({
        device,
        capability: "light",
        state: { on: device === on } as { on: true } | { on: false },
      }));
    await publishRule(core, token, "living-previous", {
      placeId: living,
      lights: only(ids.lamp),
      until: null,
      rank: "previous",
    });
    await publishRule(core, token, "living-look", {
      placeId: living,
      lights: only(ids.ceiling),
      until: null,
      rank: "look",
    });
    await lights(core, token, {
      place: { kind: "room", id: living },
      to: "on",
    });
    expect(switched()).toEqual([["ceiling-1", { on: true }]]);

    await lights(core, token, {
      place: { kind: "room", id: living },
      to: "off",
    });
    await settled();
    radio.received.length = 0;
    await publishRule(core, token, "living-chosen", {
      placeId: living,
      lights: only(ids.lamp),
      until: null,
    });
    await lights(core, token, {
      place: { kind: "room", id: living },
      to: "on",
    });
    expect(switched()).toEqual([["lamp-1", { on: true }]]);
  });

  it("brings every light on at full brightness with nothing to go by, unless the core holds a look for it", async () => {
    const { core, token, living, ids } = await home();
    for (const device of [ids.lamp, ids.ceiling]) {
      await post(
        core,
        "/api/devices/command",
        { device, capability: "light", command: { brightness: 40 } },
        { token },
      );
    }
    await lights(core, token, {
      place: { kind: "room", id: living },
      to: "off",
    });
    await settled();
    // A colour for the ceiling while it is off, which the core holds.
    await post(
      core,
      "/api/devices/command",
      {
        device: ids.ceiling,
        capability: "light",
        command: { colorTemperature: 300 },
      },
      { token },
    );
    await settled();
    radio.received.length = 0;

    await lights(core, token, {
      place: { kind: "room", id: living },
      to: "on",
    });

    expect(asked()["lamp-1"]).toMatchObject({ on: true, brightness: 100 });
    expect(asked()["ceiling-1"]).toMatchObject({
      on: true,
      brightness: 40,
      colorTemperature: 300,
    });
  });

  it.each([true, false])(
    "turns a room back on before off is confirmed, with a reserved look: %s",
    async (hasLook) => {
      const { core, token, living, ids } = await home();
      radio.confirms = false;
      const response = await post(
        core,
        "/api/devices/command",
        {
          device: ids.lamp,
          capability: "light",
          command: {
            on: false,
            ...(hasLook ? { brightness: 40, colorTemperature: 300 } : {}),
          },
        },
        { token },
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ sync: "pending" });
      radio.received.length = 0;

      await lights(core, token, {
        place: { kind: "room", id: living },
        to: "on",
      });

      expect(asked()["lamp-1"]).toMatchObject({
        on: true,
        brightness: hasLook ? 40 : 100,
        ...(hasLook ? { colorTemperature: 300 } : {}),
      });
    },
  );

  it("brings a light it leaves out on as the core remembers it", async () => {
    const { core, token, living, ids } = await darkRoom();
    await publishRule(core, token, "living", {
      placeId: living,
      lights: [
        { device: ids.ceiling, capability: "light", state: { on: false } },
      ],
      until: null,
    });

    await lights(core, token, {
      place: { kind: "room", id: living },
      to: "on",
    });

    expect(switched()).toEqual([["lamp-1", { on: true }]]);
  });

  it("goes by none once it no longer holds, or when it would leave every light off", async () => {
    const { core, token, living, ids } = await darkRoom();
    const off = [
      { device: ids.lamp, capability: "light", state: { on: false } },
      { device: ids.ceiling, capability: "light", state: { on: false } },
    ] as const;
    await publishRule(core, token, "living", {
      placeId: living,
      lights: [off[0]],
      until: new Date(core.now().getTime() - 1000).toISOString(),
    });
    await lights(core, token, {
      place: { kind: "room", id: living },
      to: "on",
    });
    expect(switched().sort()).toEqual([
      ["ceiling-1", { on: true }],
      ["lamp-1", { on: true }],
    ]);

    await lights(core, token, {
      place: { kind: "room", id: living },
      to: "off",
    });
    await settled();
    radio.received.length = 0;
    await publishRule(core, token, "living", {
      placeId: living,
      lights: [...off],
      until: null,
    });
    await lights(core, token, {
      place: { kind: "room", id: living },
      to: "on",
    });
    expect(switched().sort()).toEqual([
      ["ceiling-1", { on: true }],
      ["lamp-1", { on: true }],
    ]);
  });

  it("turns a zone or the home on room by room, each by its own rule", async () => {
    const { core, token, living, kitchen, downstairs, ids } = await darkRoom();
    // A rule names a room's lights; a light that moved since keeps none.
    await publishRule(core, token, "living", {
      placeId: living,
      lights: [
        { device: ids.lamp, capability: "light", state: { on: false } },
        { device: ids.counter, capability: "light", state: { on: false } },
      ],
      until: null,
    });

    await lights(core, token, {
      place: { kind: "zone", id: downstairs },
      to: "on",
    });

    expect(switched().sort()).toEqual([
      ["ceiling-1", { on: true }],
      ["counter-1", { on: true }],
    ]);
    expect(kitchen).not.toBe(living);
  });

  it("falls back separately for a room whose rule leaves all its reachable lights off", async () => {
    const { core, token, living, downstairs, ids } = await darkRoom();
    await publishRule(core, token, "living", {
      placeId: living,
      lights: [ids.lamp, ids.ceiling].map((device) => ({
        device,
        capability: "light",
        state: { on: false },
      })),
      until: null,
    });

    await lights(core, token, {
      place: { kind: "zone", id: downstairs },
      to: "on",
    });

    expect(switched().sort()).toEqual([
      ["ceiling-1", { on: true }],
      ["counter-1", { on: true }],
      ["lamp-1", { on: true }],
    ]);
  });

  it("keeps a rule's other lights off when its chosen light is already on", async () => {
    const { core, token, living, ids } = await home();
    await publishRule(core, token, "living", {
      placeId: living,
      lights: [
        { device: ids.lamp, capability: "light", state: { on: true } },
        { device: ids.ceiling, capability: "light", state: { on: false } },
      ],
      until: null,
    });

    const response = await lights(core, token, {
      place: { kind: "room", id: living },
      to: "on",
    });

    expect(response.json()).toEqual({ on: true, switched: 0, failed: [] });
    expect(radio.received).toEqual([]);
  });
});
