import { localDate } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  brightnessPercent,
  clampMired,
  colorTemperatureKelvin,
  kelvinToMired,
  miredToKelvin,
  peakAt,
  type CurveSettings,
} from "../src/curve.js";
import { previewOf } from "../src/preview.js";
import { defaultCurve, naturalLightSettings } from "../src/settings.js";
import { sunToday } from "../src/sun.js";
import { zurich } from "./fake-core.js";

// The curve and the sun it follows, ported from v1's
// natural-lighting.test.ts (Pragmata, v1-final) and Weather's sun tests.

const sun = {
  sunrise: new Date("2026-05-18T06:00:00.000Z"),
  solarNoon: new Date("2026-05-18T12:00:00.000Z"),
  sunset: new Date("2026-05-18T18:00:00.000Z"),
};
const at = (time: string) => new Date(`2026-05-18T${time}:00.000Z`);
const minute = 60_000;

describe("the curve", () => {
  it("calculates temperature and brightness from sun times and offsets", () => {
    const curve: CurveSettings = {
      ...defaultCurve,
      sunriseOffsetMinutes: 30,
      sunsetOffsetMinutes: -30,
    };

    expect(colorTemperatureKelvin(curve, sun, at("06:15"))).toBe(2000);
    expect(colorTemperatureKelvin(curve, sun, at("12:00"))).toBe(5500);
    expect(colorTemperatureKelvin(curve, sun, at("17:45"))).toBe(2000);
    expect(brightnessPercent(curve, sun, at("06:15"))).toBe(80);
    expect(brightnessPercent(curve, sun, at("12:00"))).toBe(100);
  });

  it("eases between the ends, halfway at halftime", () => {
    expect(colorTemperatureKelvin(defaultCurve, sun, at("09:00"))).toBe(3750);
    expect(colorTemperatureKelvin(defaultCurve, sun, at("15:00"))).toBe(3750);
    // Eased: a quarter of the way in, well under a quarter of the change.
    const early = colorTemperatureKelvin(defaultCurve, sun, at("07:30"));
    expect(early).toBeGreaterThan(2000);
    expect(early).toBeLessThan(2000 + (5500 - 2000) / 4);
  });

  it("uses an early riser curve peak one third into the daylight window", () => {
    const curve: CurveSettings = { ...defaultCurve, shape: "early_riser" };

    expect(peakAt(curve, sun).toISOString()).toBe("2026-05-18T10:00:00.000Z");
    expect(colorTemperatureKelvin(curve, sun, at("10:00"))).toBe(5500);
    expect(peakAt(defaultCurve, sun)).toEqual(sun.solarNoon);
  });

  it("peaks halfway through a day that ends before solar noon", () => {
    // Near the North Pole after the equinox the sun can be up only in the
    // morning, as at 89.875° N on 25 September 2026.
    const morning = {
      sunrise: new Date("2026-09-25T08:39:29.000Z"),
      solarNoon: new Date("2026-09-25T11:51:41.000Z"),
      sunset: new Date("2026-09-25T11:01:56.000Z"),
    };
    const halfway = new Date("2026-09-25T09:50:42.500Z");

    expect(peakAt(defaultCurve, morning)).toEqual(halfway);
    expect(colorTemperatureKelvin(defaultCurve, morning, halfway)).toBe(5500);
    // So does a short winter day whose sunset offset moves it before noon.
    const winter = {
      sunrise: new Date("2026-12-21T10:30:00.000Z"),
      solarNoon: new Date("2026-12-21T12:00:00.000Z"),
      sunset: new Date("2026-12-21T13:30:00.000Z"),
    };
    const curve = naturalLightSettings.parse({ sunsetOffsetMinutes: -120 });
    expect(peakAt(curve, winter).toISOString()).toBe(
      "2026-12-21T11:00:00.000Z",
    );
    expect(
      brightnessPercent(curve, winter, new Date("2026-12-21T11:00:00Z")),
    ).toBe(curve.highBrightness);
  });

  it("clamps color temperature to what a light can show", () => {
    const warm = clampMired(kelvinToMired(2000), { min: 154, max: 370 });
    const cool = clampMired(kelvinToMired(6500), { min: 182, max: 500 });

    expect(miredToKelvin(warm)).toBeGreaterThanOrEqual(2700);
    expect(miredToKelvin(warm)).toBeLessThan(2710);
    expect(miredToKelvin(cool)).toBeGreaterThanOrEqual(5490);
    expect(miredToKelvin(cool)).toBeLessThanOrEqual(5500);
  });
});

describe("the sun on the home's day", () => {
  it("is today's at the home, whatever the host's clock says", () => {
    const today = sunToday(zurich, new Date("2026-10-29T23:30:00Z"))!;

    expect(today.date).toBe("2026-10-30");
    expect(localDate("Europe/Zurich", today.sunrise)).toBe("2026-10-30");
    expect(localDate("Europe/Zurich", today.sunset)).toBe("2026-10-30");
    expect(today.solarNoon.getTime()).toBeGreaterThan(today.sunrise.getTime());
    expect(today.solarNoon.getTime()).toBeLessThan(today.sunset.getTime());
  });

  it("matches the published times for Zurich at midwinter", () => {
    // The shortest day, 8 h 27 min, ends just after 16:36 CET.
    const { sunrise, sunset } = sunToday(
      zurich,
      new Date("2026-12-21T10:00:00Z"),
    )!;

    expect(
      Math.abs(sunset.getTime() - sunrise.getTime() - (8 * 60 + 27) * minute),
    ).toBeLessThan(2 * minute);
    expect(sunset.getTime()).toBeGreaterThan(Date.parse("2026-12-21T15:36Z"));
    expect(sunset.getTime()).toBeLessThan(Date.parse("2026-12-21T15:41Z"));
  });

  it("counts the home's elevation, as published tables do", () => {
    const now = new Date("2026-10-29T09:00:00Z");
    const level = sunToday(zurich, now)!;
    const high = sunToday({ ...zurich, elevation: 480 }, now)!;
    const below = sunToday({ ...zurich, elevation: -100 }, now)!;

    // About five minutes earlier and later at 480 m.
    expect(level.sunrise.getTime() - high.sunrise.getTime()).toBeGreaterThan(
      2 * minute,
    );
    expect(high.sunset.getTime() - level.sunset.getTime()).toBeGreaterThan(
      2 * minute,
    );
    expect(below.sunrise).toEqual(level.sunrise);
  });

  it("is missing in a polar winter or summer, when v1 left lights alone", () => {
    const tromso = {
      latitude: 69.6492,
      longitude: 18.9553,
      elevation: null,
      timeZone: "Europe/Oslo",
    };
    for (const when of ["2026-12-21T10:00:00Z", "2026-06-21T10:00:00Z"]) {
      expect(sunToday(tromso, new Date(when))).toBeNull();
    }
  });
});

describe("the preview", () => {
  it("keeps chart points when offsets cross on a short winter day", () => {
    // About two and a half hours of daylight at sea level: by 1 December the
    // sun no longer rises there.
    const now = new Date("2026-11-25T10:30:00Z");
    const today = sunToday(
      {
        latitude: 69,
        longitude: 18,
        elevation: null,
        timeZone: "Europe/Oslo",
      },
      now,
    )!;
    const curve = naturalLightSettings.parse({
      sunriseOffsetMinutes: 120,
      sunsetOffsetMinutes: -120,
    });
    const preview = previewOf(curve, today, now);
    const times = preview.points.map((point) => Date.parse(point.at));

    expect(Date.parse(preview.sunrise)).toBeGreaterThan(
      Date.parse(preview.sunset),
    );
    expect(times.length).toBeGreaterThan(1);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const instant of [preview.sunrise, preview.sunset, preview.peak]) {
      expect(times).toContain(Date.parse(instant));
    }
    expect(
      preview.points.every((point) => point.kelvin === curve.lowKelvin),
    ).toBe(true);
  });

  it("samples today every 15 minutes from an hour before sunrise to an hour after sunset", () => {
    const now = new Date("2026-10-29T09:07:00Z");
    const today = sunToday(zurich, now)!;
    const preview = previewOf(defaultCurve, today, now);
    const times = preview.points.map((point) => Date.parse(point.at));

    expect(preview).toMatchObject({
      date: "2026-10-29",
      timeZone: "Europe/Zurich",
      sunrise: today.sunrise.toISOString(),
      sunset: today.sunset.toISOString(),
      peak: today.solarNoon.toISOString(),
      now: {
        at: now.toISOString(),
        kelvin: colorTemperatureKelvin(defaultCurve, today, now),
        brightness: brightnessPercent(defaultCurve, today, now),
      },
    });
    expect(times[0]).toBe(today.sunrise.getTime() - 60 * minute);
    expect(times.at(-1)! - today.sunset.getTime()).toBeLessThanOrEqual(
      60 * minute,
    );
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const moment of [now, today.sunrise, today.solarNoon, today.sunset]) {
      expect(times).toContain(moment.getTime());
    }
    expect(Math.max(...preview.points.map((point) => point.kelvin))).toBe(5500);
    expect(preview.points[0]).toMatchObject({ kelvin: 2000, brightness: 80 });
  });
});
