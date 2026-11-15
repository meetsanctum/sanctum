import { ColorMode, EntityCategory, type Entity } from "esphome-client";
import { describe, expect, it } from "vitest";

import { capabilityIdOf, mapEntities } from "../src/entities.js";
import { lightCommandOf, stateOf } from "../src/states.js";

// What ESPHome's entities are in Sanctum, and how their states and
// commands read there.

const entity = (fields: Record<string, unknown>) =>
  ({ key: 1, name: "Part", objectId: "part", ...fields }) as unknown as Entity;

describe("a device's entities", () => {
  it("map onto Sanctum's kinds where they are one, and the rest are listed by name", () => {
    const { mapped, unused } = mapEntities([
      entity({
        type: "light",
        key: 1,
        objectId: "bulb",
        supportedColorModes: [ColorMode.RGB_COLOR_TEMPERATURE],
        minMireds: 153,
        maxMireds: 500,
      }),
      entity({ type: "switch", key: 2, objectId: "relay" }),
      entity({
        type: "sensor",
        key: 3,
        objectId: "temp",
        deviceClass: "temperature",
        unitOfMeasurement: "°F",
      }),
      entity({
        type: "sensor",
        key: 4,
        objectId: "co2",
        name: "CO2",
        deviceClass: "carbon_dioxide",
        unitOfMeasurement: "ppm",
      }),
      entity({
        type: "binary_sensor",
        key: 5,
        objectId: "radar",
        deviceClass: "presence",
      }),
      entity({
        type: "binary_sensor",
        key: 6,
        objectId: "window",
        deviceClass: "window",
      }),
      entity({
        type: "binary_sensor",
        key: 7,
        objectId: "smoke",
        name: "Smoke",
        deviceClass: "smoke",
      }),
      entity({
        type: "event",
        key: 8,
        objectId: "remote",
        eventTypes: ["single", "double", "single"],
      }),
      entity({ type: "cover", key: 9, objectId: "blind", name: "Blind" }),
      // Its own readings and settings feed its page only.
      entity({
        type: "sensor",
        key: 10,
        objectId: "uptime",
        deviceClass: "duration",
        unitOfMeasurement: "s",
        entityCategory: EntityCategory.DIAGNOSTIC,
      }),
      entity({
        type: "button",
        key: 11,
        objectId: "restart",
        name: "Restart",
        entityCategory: EntityCategory.CONFIG,
      }),
    ]);

    expect(mapped.map((each) => each.capability)).toEqual([
      {
        id: "light-bulb",
        kind: "light",
        features: {
          brightness: true,
          colorTemperature: { min: 153, max: 500 },
          color: true,
        },
      },
      { id: "switch-relay", kind: "switch", features: {} },
      {
        id: "sensor-temp",
        kind: "sensor",
        features: { measures: "temperature" },
      },
      {
        id: "binary-radar",
        kind: "motion",
        features: { sensitivity: null, clearAfter: null, indicator: false },
      },
      { id: "binary-window", kind: "contact", features: {} },
      {
        id: "event-remote",
        kind: "button",
        features: { actions: ["single", "double"], holds: [] },
      },
    ]);
    expect(unused).toEqual(["CO2", "Smoke", "Blind", "Restart"]);
  });

  it("have ids within 32 characters, kept apart by their keys", () => {
    const long = (key: number) =>
      entity({
        type: "binary_sensor",
        key,
        objectId: "living_room_window_left_contact",
      });

    expect(capabilityIdOf(long(1))).toBe("binary-living_room_wind-00000001");
    expect(capabilityIdOf(long(2))).not.toBe(capabilityIdOf(long(1)));
    expect(capabilityIdOf(long(1)).length).toBeLessThanOrEqual(32);
  });

  it("bring a light with only on and off as one without brightness", () => {
    const { mapped } = mapEntities([
      entity({ type: "light", supportedColorModes: [ColorMode.ON_OFF] }),
    ]);

    expect(mapped[0]!.capability.features).toEqual({
      brightness: false,
      colorTemperature: null,
      color: false,
    });
  });
});

describe("states and commands", () => {
  const [light] = mapEntities([
    entity({
      type: "light",
      supportedColorModes: [ColorMode.COLOR_TEMPERATURE, ColorMode.RGB],
      minMireds: 153,
      maxMireds: 500,
    }),
  ]).mapped;

  it("read a light's brightness, colour temperature and colour as Sanctum has them", () => {
    expect(
      stateOf(light!, {
        type: "light",
        key: 1,
        entity: "Part",
        state: true,
        brightness: 0.4,
        colorMode: ColorMode.COLOR_TEMPERATURE,
        colorTemperature: 370.2,
      } as never),
    ).toEqual({
      on: true,
      brightness: 40,
      colorMode: "temperature",
      colorTemperature: 370,
    });
    expect(
      stateOf(light!, {
        type: "light",
        key: 1,
        entity: "Part",
        state: true,
        brightness: 1,
        colorMode: ColorMode.RGB,
        red: 0.2,
        green: 1,
        blue: 0.2,
      } as never),
    ).toEqual({
      on: true,
      brightness: 100,
      colorMode: "color",
      hue: 120,
      saturation: 80,
    });
  });

  it("ask a light for what Sanctum asks, in the mode that has it", () => {
    expect(lightCommandOf(light!.entity, { brightness: 0 })).toEqual({
      state: false,
    });
    expect(
      lightCommandOf(light!.entity, { brightness: 40, transitionSeconds: 1.5 }),
    ).toEqual({
      brightness: 0.4,
      state: true,
      transitionLength: 1500,
    });
    expect(lightCommandOf(light!.entity, { colorTemperature: 300 })).toEqual({
      colorTemperature: 300,
      colorMode: ColorMode.COLOR_TEMPERATURE,
    });
    expect(
      lightCommandOf(light!.entity, { hue: 120, saturation: 80 }),
    ).toMatchObject({
      colorMode: ColorMode.RGB,
      rgb: { r: expect.closeTo(0.2), g: 1, b: expect.closeTo(0.2) },
    });
  });

  it("read a temperature in degrees Celsius whatever unit the device says it in", () => {
    const [fahrenheit] = mapEntities([
      entity({
        type: "sensor",
        deviceClass: "temperature",
        unitOfMeasurement: "°F",
      }),
    ]).mapped;

    expect(
      stateOf(fahrenheit!, {
        type: "sensor",
        key: 1,
        entity: "Part",
        state: 70.7,
      } as never),
    ).toEqual({ value: 21.5 });
    expect(
      stateOf(fahrenheit!, {
        type: "sensor",
        key: 1,
        entity: "Part",
        state: Number.NaN,
      } as never),
    ).toBeNull();
    expect(
      stateOf(fahrenheit!, {
        type: "sensor",
        key: 1,
        entity: "Part",
        state: 1,
        missingState: true,
      } as never),
    ).toBeNull();
  });
});
