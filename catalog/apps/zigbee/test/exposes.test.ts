import { describe, expect, it } from "vitest";

import { capabilityMappings } from "../src/exposes.js";
import { actionExpose, lightExpose, switchExpose } from "./pretend-bridge.js";

// Exposes onto capabilities.

describe("a device's exposes", () => {
  it("make a light with what it can do", () => {
    // A desk lamp.
    const [lamp] = capabilityMappings([
      {
        type: "light",
        features: [
          { property: "state", type: "binary", name: "state" },
          { property: "brightness", type: "numeric", name: "brightness" },
          { name: "color_hs", type: "composite", property: "color" },
          {
            name: "color_temp",
            property: "color_temp",
            type: "numeric",
            value_max: 454,
            value_min: 200,
          },
        ],
      },
    ]);

    expect(lamp).toMatchObject({
      id: "light",
      kind: "light",
      features: {
        brightness: true,
        colorTemperature: { min: 200, max: 454 },
        color: true,
      },
      state: { property: "state", on: "ON", off: "OFF" },
      brightness: "brightness",
      colorTemperature: "color_temp",
      color: "color",
      colorMode: "color_mode",
    });
  });

  it("make a plain switch", () => {
    expect(capabilityMappings([switchExpose()])).toEqual([
      {
        id: "switch",
        kind: "switch",
        features: {},
        state: { property: "state", on: "ON", off: "OFF" },
        readable: ["state"],
      },
    ]);
  });

  it("make one capability per endpoint, with the endpoint's properties", () => {
    const mappings = capabilityMappings([
      switchExpose("l1"),
      switchExpose("l2"),
      lightExpose({ endpoint: "L3", colorTemperature: [153, 370] }),
    ]);

    expect(mappings.map((each) => each.id)).toEqual(["l1", "l2", "l3"]);
    expect(mappings[1]).toMatchObject({ state: { property: "state_l2" } });
    expect(mappings[2]).toMatchObject({
      brightness: "brightness_L3",
      colorTemperature: "color_temp_L3",
      colorMode: "color_mode_L3",
      readable: ["state_L3", "brightness_L3", "color_temp_L3"],
    });
  });

  it("make a button of a remote's actions, leaving out release-like ones", () => {
    // An office button, an Aqara wireless mini switch (WXKG11LM).
    expect(
      capabilityMappings([
        actionExpose([
          "single",
          "double",
          "triple",
          "quadruple",
          "hold",
          "release",
        ]),
        { type: "numeric", property: "battery", unit: "%" },
      ]),
    ).toEqual([
      {
        id: "button",
        kind: "button",
        property: "action",
        features: {
          actions: ["single", "double", "triple", "quadruple", "hold"],
          holds: ["hold"],
        },
        tapsAtRelease: [],
        readable: [],
      },
    ]);
    // A Hue dimmer switch gen 1 (RWL021).
    const [dimmer] = capabilityMappings([
      actionExpose(
        ["on", "up", "down", "off"].flatMap((button) => [
          `${button}_press`,
          `${button}_press_release`,
          `${button}_hold`,
          `${button}_hold_release`,
        ]),
      ),
    ]);
    expect(dimmer?.features).toEqual({
      actions: [
        "on_press",
        "on_hold",
        "up_press",
        "up_hold",
        "down_press",
        "down_hold",
        "off_press",
        "off_hold",
      ],
      holds: ["on_hold", "up_hold", "down_hold", "off_hold"],
    });
  });

  it("make one button of action exposes that publish in the same property", () => {
    expect(
      capabilityMappings([
        { ...actionExpose(["single", "hold"]), endpoint: "left" },
        switchExpose("left"),
        { ...actionExpose(["single", "double"]), endpoint: "right" },
      ]),
    ).toEqual([
      {
        id: "button",
        kind: "button",
        property: "action",
        features: { actions: ["single", "hold", "double"], holds: ["hold"] },
        tapsAtRelease: [],
        readable: [],
      },
      // A switch on the same endpoint keeps its own capability.
      expect.objectContaining({ id: "left", kind: "switch" }),
    ]);
  });

  it("leave out an action expose with no presses", () => {
    expect(
      capabilityMappings([
        actionExpose(["release", "brightness_stop", "", 3, "two words"]),
        { type: "enum", property: "action" },
      ]),
    ).toEqual([]);
  });

  it("leave out anything that is not a light, a switch, buttons, a room's reading or motion, rather than guess", () => {
    expect(
      capabilityMappings([
        // A plug's own chip and a thermostat's are not the room's.
        { type: "numeric", property: "device_temperature", unit: "°C" },
        { type: "numeric", property: "local_temperature", unit: "°C" },
        { type: "numeric", property: "pressure", unit: "hPa" },
        // A door's contact, and a radar's presence.
        { type: "binary", property: "contact" },
        { type: "binary", property: "presence" },
        { type: "enum", property: "power_on_behavior", values: ["on"] },
        { type: "cover", features: [{ name: "state", property: "state" }] },
        { type: "binary", property: "state" },
      ]),
    ).toEqual([]);
  });

  it("leave out a light or switch that cannot be switched", () => {
    expect(
      capabilityMappings([
        { type: "light", features: [] },
        {
          type: "switch",
          features: [{ name: "state", property: "state", access: 1 }],
        },
      ]),
    ).toEqual([]);
  });

  it("leave out features a light cannot be told", () => {
    const [lamp] = capabilityMappings([
      {
        type: "light",
        features: [
          { name: "state", property: "state", access: 7 },
          { name: "brightness", property: "brightness", access: 1 },
          { name: "color_xy", property: "color", access: 5 },
        ],
      },
    ]);

    expect(lamp?.features).toEqual({
      brightness: false,
      colorTemperature: null,
      color: false,
    });
    expect(lamp).not.toHaveProperty("brightness");
  });

  it("give a colour temperature range the light kind takes", () => {
    const range = (value_min?: number, value_max?: number) => {
      const [lamp] = capabilityMappings([
        {
          type: "light",
          features: [
            { name: "state", property: "state" },
            {
              name: "color_temp",
              property: "color_temp",
              value_min,
              value_max,
            },
          ],
        },
      ]);
      return lamp?.kind === "light" ? lamp.features.colorTemperature : null;
    };

    expect(range(142.6, 555.2)).toEqual({ min: 143, max: 555 });
    // The default range when the light gives none, or one the kind cannot take.
    expect(range()).toEqual({ min: 153, max: 500 });
    expect(range(0, 65535)).toEqual({ min: 153, max: 500 });
    expect(range(500, 153)).toEqual({ min: 153, max: 500 });
  });

  it("keep one capability per id", () => {
    expect(
      capabilityMappings([switchExpose(), switchExpose(), lightExpose()]).map(
        (each) => each.id,
      ),
    ).toEqual(["switch", "light"]);
  });
});
