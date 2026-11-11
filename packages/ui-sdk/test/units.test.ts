import { describe, expect, it } from "vitest";

import {
  convertTemperature,
  formatNumber,
  formatLightLevel,
  formatLightLevelRange,
  formatReading,
  formatTemperature,
  formatTemperatureRange,
  shownReading,
  temperatureUnitOf,
} from "../src/units";

describe("temperatureUnitOf", () => {
  it("reads a reading's own unit however a device writes it", () => {
    expect(temperatureUnitOf("°C")).toBe("celsius");
    expect(temperatureUnitOf(" c ")).toBe("celsius");
    expect(temperatureUnitOf("°F")).toBe("fahrenheit");
    expect(temperatureUnitOf("fahrenheit")).toBe("fahrenheit");
    expect(temperatureUnitOf("%")).toBeNull();
    expect(temperatureUnitOf("")).toBeNull();
  });
});

describe("convertTemperature", () => {
  it("converts both ways", () => {
    expect(convertTemperature(20, "celsius", "fahrenheit")).toBe(68);
    expect(convertTemperature(68, "fahrenheit", "celsius")).toBe(20);
    expect(convertTemperature(21.5, "celsius", "celsius")).toBe(21.5);
  });
});

describe("formatNumber", () => {
  it("shows a whole number when it is all but whole, else a tenth", () => {
    expect(formatNumber(21)).toBe("21");
    expect(formatNumber(21.04)).toBe("21");
    expect(formatNumber(21.5)).toBe("21.5");
    expect(formatNumber(22.25)).toBe("22.3");
    expect(formatNumber(-0.02)).toBe("0");
  });
});

describe("formatTemperature", () => {
  it("shows a Celsius value in the unit shown", () => {
    expect(formatTemperature(20, "fahrenheit")).toBe("68°F");
    expect(formatTemperature(21.5, "celsius")).toBe("21.5°C");
    expect(formatTemperature(22.4, "fahrenheit", { compact: true })).toBe(
      "72.3°",
    );
  });

  it("converts from Fahrenheit too", () => {
    expect(formatTemperature(68, "celsius", { from: "fahrenheit" })).toBe(
      "20°C",
    );
  });

  it("rounds to whole degrees, as a forecast shows them", () => {
    expect(
      formatTemperature(11.4, "celsius", { compact: true, whole: true }),
    ).toBe("11°");
    expect(
      formatTemperature(11.4, "fahrenheit", { compact: true, whole: true }),
    ).toBe("53°");
    expect(
      formatTemperature(-0.3, "celsius", { compact: true, whole: true }),
    ).toBe("0°");
  });

  it("shows a dash while there is no value", () => {
    expect(formatTemperature(null, "celsius")).toBe("–");
  });
});

describe("formatTemperatureRange", () => {
  it("shows the lowest and highest, lowest first", () => {
    expect(formatTemperatureRange(22, 19.5, "celsius")).toBe("19.5–22°C");
    expect(
      formatTemperatureRange(19, 22, "fahrenheit", { compact: true }),
    ).toBe("66.2–71.6°");
  });

  it("shows one when they come out the same", () => {
    expect(formatTemperatureRange(21, 21, "celsius")).toBe("21°C");
    expect(formatTemperatureRange(20.98, 21.02, "celsius")).toBe("21°C");
  });
});

describe("shownReading", () => {
  it("gives a chart the number shown, converting temperatures only", () => {
    expect(shownReading(20, "°C", "fahrenheit")).toEqual({
      value: 68,
      unit: "°F",
    });
    expect(shownReading(48, "%", "fahrenheit")).toEqual({
      value: 48,
      unit: "%",
    });
  });
});

describe("formatReading", () => {
  it("shows a temperature reading in the unit shown", () => {
    expect(formatReading(20, "°C", "fahrenheit")).toBe("68°F");
    expect(formatReading(21.5, "°C", "celsius", { compact: true })).toBe(
      "21.5°",
    );
  });

  it("keeps other units, a percentage right after the number", () => {
    expect(formatReading(48, "%", "celsius")).toBe("48%");
    expect(formatReading(1013.25, "hPa", "celsius")).toBe("1013.3 hPa");
    expect(formatReading(3, "", "celsius")).toBe("3");
  });
});

describe("formatLightLevel", () => {
  it("shows whole lux under 100 and two figures from 100", () => {
    expect(formatLightLevel(4.4)).toBe("4 lx");
    expect(formatLightLevel(0)).toBe("0 lx");
    expect(formatLightLevel(99.4)).toBe("99 lx");
    expect(formatLightLevel(99.6)).toBe("100 lx");
    expect(formatLightLevel(318)).toBe("320 lx");
    expect(formatLightLevel(1_064)).toBe("1,100 lx");
    expect(formatLightLevel(23_412)).toBe("23,000 lx");
  });

  it("never shows less than nothing", () => {
    expect(formatLightLevel(-0.3)).toBe("0 lx");
  });
});

describe("formatLightLevelRange", () => {
  it("shows the lowest and highest, or one when they read the same", () => {
    expect(formatLightLevelRange(40.2, 318)).toBe("40–320 lx");
    expect(formatLightLevelRange(0, 1_064)).toBe("0–1,100 lx");
    expect(formatLightLevelRange(321, 318)).toBe("320 lx");
  });
});
