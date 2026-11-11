import { describe, expect, it } from "vitest";

import { lightColour } from "../src/tiles";

describe("lightColour", () => {
  it("shows warm white for a light that only dims", () => {
    expect(lightColour({ on: true, brightness: 80 })).toBe("#ffcfa3");
  });

  it("follows a colour temperature", () => {
    expect(
      lightColour({
        on: true,
        colorMode: "temperature",
        colorTemperature: 154,
      }),
    ).toBe("#fffefc");
  });

  it("follows a colour, lightened for Carbon text", () => {
    expect(
      lightColour({ on: true, colorMode: "color", hue: 240, saturation: 100 }),
    ).toBe("#7373ff");
  });
});
