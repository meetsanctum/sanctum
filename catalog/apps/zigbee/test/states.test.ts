import { describe, expect, it } from "vitest";

import {
  capabilityMappings,
  type LightMapping,
  type SwitchMapping,
} from "../src/exposes.js";
import {
  commandPayload,
  movePayload,
  stateFromPayload,
} from "../src/states.js";
import { lightExpose, switchExpose } from "./pretend-bridge.js";

// Messages onto states and commands onto <device>/set.

function mapping(expose: Parameters<typeof capabilityMappings>[0][number]) {
  return capabilityMappings([expose])[0] as LightMapping | SwitchMapping;
}

const lamp = mapping(
  lightExpose({ colorTemperature: [153, 500], color: "color_hs" }),
);
const dimmer = mapping(lightExpose());
const warmWhite = mapping(lightExpose({ colorTemperature: [153, 454] }));
const colourOnly = mapping(lightExpose({ color: "color_xy" }));

describe("a light's state", () => {
  it("is read from a message, brightness in percent", () => {
    // A desk lamp's report.
    expect(
      stateFromPayload(lamp, {
        state: "ON",
        brightness: 127,
        color: { hue: 120, saturation: 80, x: 0.2, y: 0.6 },
        color_mode: "color_temp",
        color_temp: 320,
        linkquality: 90,
      }),
    ).toEqual({
      on: true,
      brightness: 50,
      colorMode: "temperature",
      colorTemperature: 320,
      hue: 120,
      saturation: 80,
    });
  });

  it("says its brightness when off too, so the core can tell what it comes back at", () => {
    expect(stateFromPayload(dimmer, { state: "OFF", brightness: 1 })).toEqual({
      on: false,
      brightness: 1,
    });
    expect(stateFromPayload(dimmer, { state: "OFF", brightness: 0 })).toEqual({
      on: false,
      brightness: 0,
    });
  });

  it("is never on at 0: the core keeps the brightness it had", () => {
    expect(stateFromPayload(dimmer, { state: "ON", brightness: 0 })).toEqual({
      on: true,
    });
    expect(stateFromPayload(dimmer, { state: "ON", brightness: 1 })).toEqual({
      on: true,
      brightness: 1,
    });
  });

  it("is nothing while a message does not say whether it is on", () => {
    expect(stateFromPayload(lamp, { brightness: 80, linkquality: 4 })).toBe(
      null,
    );
  });

  it("is in the only colour mode a light has, when the message does not say", () => {
    expect(
      stateFromPayload(warmWhite, { state: "ON", color_temp: 250 }),
    ).toMatchObject({ colorMode: "temperature" });
    expect(
      stateFromPayload(colourOnly, {
        state: "ON",
        color: { hue: 10, saturation: 20 },
      }),
    ).toMatchObject({ colorMode: "color" });
    expect(stateFromPayload(lamp, { state: "ON" })).toEqual({ on: true });
    expect(stateFromPayload(dimmer, { state: "ON", color_mode: "hs" })).toEqual(
      { on: true },
    );
  });

  it("leaves out values the light kind cannot take", () => {
    expect(
      stateFromPayload(lamp, {
        state: "ON",
        brightness: "bright",
        color_temp: 65535,
        color: { hue: 400, saturation: 50 },
      }),
    ).toEqual({ on: true });
    expect(stateFromPayload(lamp, { state: "ON", color: { hue: 30 } })).toEqual(
      { on: true },
    );
  });

  it("is read from an endpoint's own properties", () => {
    const second = mapping(lightExpose({ endpoint: "l2", color: "color_hs" }));

    expect(
      stateFromPayload(second, {
        state: "OFF",
        state_l2: "ON",
        brightness_l2: 254,
        color_l2: { hue: 200, saturation: 100 },
        color_mode_l2: "hs",
      }),
    ).toEqual({
      on: true,
      brightness: 100,
      colorMode: "color",
      hue: 200,
      saturation: 100,
    });
  });
});

describe("a switch's state", () => {
  it("is whether it is on", () => {
    const plug = mapping(switchExpose());
    expect(stateFromPayload(plug, { state: "ON", power: 12 })).toEqual({
      on: true,
    });
    expect(stateFromPayload(plug, { power: 12 })).toBeNull();
  });
});

describe("a command", () => {
  it("switches a switch, on its endpoint", () => {
    expect(commandPayload(mapping(switchExpose()), { on: false })).toEqual({
      state: "OFF",
    });
    expect(commandPayload(mapping(switchExpose("l2")), { on: true })).toEqual({
      state_l2: "ON",
    });
  });

  it("asks a light for what the core prepared, brightness from percent", () => {
    // A light's state.
    expect(
      commandPayload(lamp, {
        on: true,
        brightness: 40,
        colorTemperature: 280,
        transitionSeconds: 2,
      }),
    ).toEqual({ state: "ON", brightness: 102, color_temp: 280, transition: 2 });
    // A light's colour.
    expect(commandPayload(lamp, { hue: 42, saturation: 60 })).toEqual({
      color: { hue: 42, saturation: 60 },
    });
    expect(commandPayload(lamp, { on: false })).toEqual({ state: "OFF" });
  });

  it("uses an endpoint's properties", () => {
    const second = mapping(
      lightExpose({ endpoint: "l2", colorTemperature: [153, 500] }),
    );
    expect(
      commandPayload(second, {
        on: true,
        brightness: 100,
        colorTemperature: 300,
      }),
    ).toEqual({ state_l2: "ON", brightness_l2: 254, color_temp_l2: 300 });
  });
});

describe("a move", () => {
  it("moves a light's brightness at levels a second, and stops it", () => {
    const light = dimmer as LightMapping;
    // 25% a second goes from the lowest to full in about 4 seconds.
    expect(movePayload(light, { move: "up", percentPerSecond: 25 })).toEqual({
      brightness_move: 64,
    });
    expect(movePayload(light, { move: "down", percentPerSecond: 25 })).toEqual({
      brightness_move: -64,
    });
    expect(movePayload(light, { move: "stop" })).toEqual({
      brightness_move: "stop",
    });
  });

  it("uses an endpoint's property, and needs a light that can dim", () => {
    const second = mapping(lightExpose({ endpoint: "l2" })) as LightMapping;
    expect(movePayload(second, { move: "up", percentPerSecond: 50 })).toEqual({
      brightness_move_l2: 127,
    });
    expect(
      movePayload({ ...second, brightness: undefined }, { move: "stop" }),
    ).toBeNull();
  });
});
