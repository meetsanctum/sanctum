import type { SunDay } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { arcPoint, daylightWords, sunArc, sunPath } from "../src/sun-path.js";

// The sun's day on Weather's page.

const day: SunDay = {
  date: "2026-11-16",
  sunrise: "2026-11-16T06:31:00.000Z",
  sunset: "2026-11-16T15:48:00.000Z",
  solarNoon: "2026-11-16T11:09:30.000Z",
};

describe("the sun's path", () => {
  it("says how long the sun is up and how far along it is", () => {
    expect(sunPath(day, new Date("2026-11-16T11:09:30Z"))).toEqual({
      sunrise: day.sunrise,
      sunset: day.sunset,
      daylightMinutes: 557,
      progress: 0.5,
      isUp: true,
    });
    expect(daylightWords(557)).toBe("9 h 17 min");
    expect(daylightWords(60)).toBe("1 h 0 min");
  });

  it("keeps the sun at either end while it is down", () => {
    expect(sunPath(day, new Date("2026-11-16T05:00:00Z"))).toMatchObject({
      progress: 0,
      isUp: false,
    });
    expect(sunPath(day, new Date("2026-11-16T15:48:00Z"))).toMatchObject({
      progress: 1,
      isUp: false,
    });
    expect(sunPath(day, new Date("2026-11-16T22:00:00Z"))).toMatchObject({
      progress: 1,
      isUp: false,
    });
  });

  it("has none on a day the sun doesn't both rise and set", () => {
    expect(sunPath({ ...day, sunrise: null, sunset: null })).toBeNull();
    expect(sunPath({ ...day, sunset: null })).toBeNull();
    expect(sunPath(undefined)).toBeNull();
  });
});

describe("the sun on its arc", () => {
  it("starts at sunrise's end of the horizon and ends at sunset's", () => {
    expect(arcPoint(0)).toEqual(sunArc.start);
    expect(arcPoint(1)).toEqual(sunArc.end);
  });

  it("is highest halfway, in the middle", () => {
    expect(arcPoint(0.5)).toEqual({ x: 130, y: 11 });
    expect(arcPoint(0.25).y).toBeGreaterThan(arcPoint(0.5).y);
    expect(arcPoint(0.25)).toEqual({
      x: 70,
      y: arcPoint(0.75).y,
    });
  });
});
