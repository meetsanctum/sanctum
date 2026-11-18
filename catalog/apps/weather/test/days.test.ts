import { describe, expect, it } from "vitest";

import { daysFromToday, homeDate, temperatureSpans } from "../src/days.js";
import { forecast, morning } from "./sample.js";

// The home's days, for Weather's card and its page.

describe("the home's days", () => {
  it("start with its today, whatever the forecast still holds", () => {
    expect(homeDate("Europe/Zurich", morning)).toBe("2026-10-29");
    expect(homeDate("Pacific/Auckland", morning)).toBe("2026-10-29");
    expect(homeDate("Pacific/Honolulu", morning)).toBe("2026-10-28");
    expect(daysFromToday(forecast, morning).map((day) => day.date)).toEqual([
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
  });
});

describe("the days' bars", () => {
  const day = (min: number | null, max: number | null) => ({
    ...forecast.days[0]!,
    temperatureMinC: min,
    temperatureMaxC: max,
  });

  it("share a scale from the coldest low to the warmest high", () => {
    expect(temperatureSpans([day(4, 12), day(-4, 4), day(0, 2)])).toEqual([
      { start: 0.5, width: 0.5 },
      { start: 0, width: 0.5 },
      { start: 0.25, width: 0.125 },
    ]);
  });

  it("leave out a day without its low or its high", () => {
    expect(temperatureSpans([day(4, null), day(0, 10), day(null, 3)])).toEqual([
      null,
      { start: 0, width: 1 },
      null,
    ]);
  });

  it("fill the scale when every day is at one temperature", () => {
    expect(temperatureSpans([day(5, 5), day(5, 5)])).toEqual([
      { start: 0, width: 1 },
      { start: 0, width: 1 },
    ]);
    expect(temperatureSpans([])).toEqual([]);
  });
});
