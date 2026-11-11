import { describe, expect, it } from "vitest";

import {
  availabilityValue,
  brightnessFromZigbee,
  brightnessToZigbee,
  colorModeValue,
  numericValue,
  powerValue,
} from "../src/values.js";

describe("brightness", () => {
  it("comes back from Zigbee as the percentage a command asked for", () => {
    for (let percent = 0; percent <= 100; percent += 1) {
      expect(brightnessFromZigbee(brightnessToZigbee(percent))).toBe(percent);
    }
  });

  it("is at least 1% for any Zigbee level of 1 or more", () => {
    for (let level = 1; level <= 254; level += 1) {
      expect(brightnessFromZigbee(level)).toBeGreaterThanOrEqual(1);
    }
    expect(brightnessFromZigbee(1)).toBe(1);
    expect(brightnessFromZigbee(0)).toBe(0);
  });

  it("maps the ends of each range onto each other and stays inside them", () => {
    expect(brightnessToZigbee(100)).toBe(254);
    expect(brightnessToZigbee(1)).toBe(3);
    expect(brightnessFromZigbee(254)).toBe(100);
    expect(brightnessFromZigbee(255)).toBe(100);
    expect(brightnessToZigbee(120)).toBe(254);
    expect(brightnessFromZigbee(-4)).toBe(0);
  });
});

describe("Zigbee2MQTT values", () => {
  it("reads a binary feature with its own values, or ON and OFF", () => {
    expect(powerValue("ON")).toBe(true);
    expect(powerValue("off")).toBe(false);
    expect(powerValue(true)).toBe(true);
    expect(powerValue("TOGGLE")).toBeNull();
    expect(powerValue(undefined)).toBeNull();
    expect(powerValue(1, { on: 1, off: 0 })).toBe(true);
    expect(powerValue(0, { on: 1, off: 0 })).toBe(false);
  });

  it("names colour modes as the light kind does", () => {
    expect(colorModeValue("color_temp")).toBe("temperature");
    expect(colorModeValue("hs")).toBe("color");
    expect(colorModeValue("xy")).toBe("color");
    expect(colorModeValue("rainbow")).toBeNull();
  });

  it("reads availability as JSON or plain text", () => {
    expect(availabilityValue(Buffer.from('{"state":"online"}'))).toBe("online");
    expect(availabilityValue(Buffer.from('{"state":"offline"}'))).toBe(
      "offline",
    );
    expect(availabilityValue(Buffer.from("online"))).toBe("online");
    expect(availabilityValue(Buffer.from(" OFFLINE "))).toBe("offline");
    expect(availabilityValue(Buffer.from("garbage"))).toBe("offline");
  });

  it("reads numbers, including numeric strings", () => {
    expect(numericValue(12)).toBe(12);
    expect(numericValue("12.5")).toBe(12.5);
    expect(numericValue("")).toBeNull();
    expect(numericValue(Number.NaN)).toBeNull();
    expect(numericValue({})).toBeNull();
  });
});
