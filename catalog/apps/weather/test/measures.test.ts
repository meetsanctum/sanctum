import { describe, expect, it } from "vitest";

import {
  fallLine,
  fallOf,
  uvLevel,
  uvLine,
  windFrom,
  windLine,
} from "../src/measures.js";
import { forecast } from "./sample.js";

// Today's measures on Weather's page.

const day = forecast.days[1]!;
const time = (instant: string) => instant.slice(11, 16);

describe("what falls today", () => {
  it("is rain in millimetres", () => {
    expect(fallOf(day)).toEqual({ kind: "rain", amount: 6.5 });
    expect(fallOf({ ...day, precipitationSumMm: 0 })).toEqual({
      kind: "rain",
      amount: 0,
    });
  });

  it("is snow in centimetres when most of it falls as snow", () => {
    // 6.4 cm of snow is about 9 mm of water.
    expect(
      fallOf({ ...day, precipitationSumMm: 9.1, snowfallSumCm: 6.4 }),
    ).toEqual({ kind: "snow", amount: 6.4 });
    // A little sleet in a day of rain.
    expect(
      fallOf({ ...day, precipitationSumMm: 12, snowfallSumCm: 0.7 }),
    ).toEqual({ kind: "rain", amount: 12 });
  });

  it("is unknown for a day without amounts", () => {
    const { precipitationSumMm, snowfallSumCm, ...bare } = day;
    expect(precipitationSumMm).toBe(6.5);
    expect(snowfallSumCm).toBe(0);

    expect(fallOf(bare)).toEqual({ kind: "rain", amount: null });
    expect(fallOf(undefined)).toEqual({ kind: "rain", amount: null });
  });

  it("says until when, from when, or that none comes", () => {
    const rain = { kind: "rain", amount: 6.5 } as const;
    const until = "2026-10-29T15:00:00.000Z";

    expect(
      fallLine(
        rain,
        { kind: "wet-until", words: "Rain", until, hasBreaks: false },
        time,
      ),
    ).toBe("Until 15:00");
    expect(
      fallLine(rain, { kind: "wet", words: "Rain", hasBreaks: true }, time),
    ).toBe("Rest of the day");
    expect(
      fallLine(rain, { kind: "dry-until", words: "Rain", until }, time),
    ).toBe("From 15:00");
    expect(fallLine(rain, { kind: "dry", words: "Overcast" }, time)).toBe(
      "No more today",
    );
    expect(
      fallLine(
        { kind: "rain", amount: 0 },
        { kind: "dry", words: "Clear" },
        time,
      ),
    ).toBe("None today");
    // Dry hours ahead don't say that none fell before them.
    expect(
      fallLine(
        { kind: "rain", amount: null },
        { kind: "dry", words: "Clear" },
        time,
      ),
    ).toBe("");
    expect(fallLine(rain, null, time)).toBe("");
  });
});

describe("the wind", () => {
  it("comes from one of eight directions", () => {
    expect(
      [0, 22, 23, 90, 135, 180, 225, 268, 315, 338, 360].map(windFrom),
    ).toEqual([
      "North",
      "North",
      "North-east",
      "East",
      "South-east",
      "South",
      "South-west",
      "West",
      "North-west",
      "North",
      "North",
    ]);
  });

  it("says where from and its gusts, with what is known", () => {
    expect(windLine({ windDirection: 268, windGustsKmh: 22.3 })).toBe(
      "W, gusts 22",
    );
    expect(windLine({ windDirection: 225, windGustsKmh: 22.3 })).toBe(
      "SW, gusts 22",
    );
    expect(windLine({ windDirection: 268, windGustsKmh: null })).toBe("West");
    expect(windLine({ windDirection: null, windGustsKmh: 22.3 })).toBe(
      "Gusts 22",
    );
    expect(windLine({ windDirection: null, windGustsKmh: null })).toBe("");
  });
});

describe("the UV index", () => {
  it("has a word for how strong it is", () => {
    expect([0, 2.4, 2.5, 5, 6, 7.4, 8, 10, 11, 14].map(uvLevel)).toEqual([
      "Low",
      "Low",
      "Moderate",
      "Moderate",
      "High",
      "High",
      "Very high",
      "Very high",
      "Extreme",
      "Extreme",
    ]);
  });

  it("says how high it gets today", () => {
    expect(uvLine(1.4)).toBe("Low all day");
    expect(uvLine(6.2)).toBe("Up to high");
    expect(uvLine(9)).toBe("Up to very high");
    expect(uvLine(null)).toBe("");
    expect(uvLine(undefined)).toBe("");
  });
});
