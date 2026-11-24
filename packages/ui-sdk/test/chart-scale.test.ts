import { describe, expect, it } from "vitest";

import { hourlyMeans } from "../src/charts/line";
import { scaleOf } from "../src/charts/scale";

// What the charts work out from what they're given: a line's hourly means
// for a screen reader, and round values for a chart's gridlines.

const minute = 60_000;

describe("a day's line", () => {
  it("is an hour's mean at a time for a screen reader", () => {
    const hour = Date.parse("2026-10-31T10:00:00.000Z");
    expect(
      hourlyMeans([
        [
          { at: hour + 5 * minute, value: 20 },
          { at: hour + 30 * minute, value: 22 },
          { at: hour + 65 * minute, value: 23 },
        ],
      ]),
    ).toEqual([
      { at: hour, value: 21 },
      { at: hour + 60 * minute, value: 23 },
    ]);
  });
});

describe("a chart's gridlines", () => {
  it("are two or three round values within what it shows, with room either side", () => {
    expect(scaleOf(19.8, 22.4)).toEqual({
      lines: [20, 22],
      min: 18.8,
      max: 23.4,
    });
    expect(scaleOf(46, 58).lines).toEqual([50, 55]);
    expect(scaleOf(20.1, 20.4).lines).toEqual([20.5]);
    expect(scaleOf(42, 62).lines).toEqual([50, 60]);
    const flat = scaleOf(21.5, 21.5);
    expect(flat.lines).toEqual([21.5]);
    expect(flat.min).toBeLessThan(21.5);
    expect(flat.max).toBeGreaterThan(21.5);
  });

  it("finds round lux for a light level, however bright", () => {
    expect(scaleOf(0, 1_100).lines).toEqual([0, 500, 1_000]);
    expect(scaleOf(4, 320).lines).toEqual([200]);
    expect(scaleOf(800, 42_000).lines).toEqual([20_000, 40_000]);
  });
});
