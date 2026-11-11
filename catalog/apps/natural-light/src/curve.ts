// The curve lights follow through the day, ported from v1's
// natural-lighting-curve.ts (Pragmata, v1-final): warm and dim from sunset
// to sunrise, cooling and brightening to a peak at solar noon (or a third
// into the day for an early riser), then back, eased at both ends. Times
// shift with the sunrise and sunset offsets.

export const curveShapes = ["balanced", "early_riser"] as const;
export type CurveShape = (typeof curveShapes)[number];

export type CurveSettings = {
  shape: CurveShape;
  lowKelvin: number;
  highKelvin: number;
  lowBrightness: number;
  highBrightness: number;
  sunriseOffsetMinutes: number;
  sunsetOffsetMinutes: number;
};

/** The home's sun on one day, which the curve follows. */
export type SunDay = { sunrise: Date; sunset: Date; solarNoon: Date };

export function colorTemperatureKelvin(
  curve: CurveSettings,
  sun: SunDay,
  now: Date,
) {
  return along(curve, sun, now, curve.lowKelvin, curve.highKelvin);
}

export function brightnessPercent(
  curve: CurveSettings,
  sun: SunDay,
  now: Date,
) {
  return along(curve, sun, now, curve.lowBrightness, curve.highBrightness);
}

/**
 * When the curve peaks: solar noon, or a third into the day for an early
 * riser. When solar noon falls outside the day, as when an offset moves
 * sunset before it or near the poles, where the sun can rise and set before
 * noon, it peaks halfway through the day instead, so that it still reaches
 * its high values.
 */
export function peakAt(curve: CurveSettings, sun: SunDay) {
  const { sunrise, sunset } = shifted(curve, sun);
  if (sunset <= sunrise) {
    return sun.solarNoon;
  }
  if (curve.shape === "early_riser") {
    return new Date(sunrise + (sunset - sunrise) / 3);
  }
  const noon = sun.solarNoon.getTime();
  if (noon > sunrise && noon < sunset) {
    return sun.solarNoon;
  }
  return new Date(sunrise + (sunset - sunrise) / 2);
}

/** Sunrise and sunset with the curve's offsets, as instants. */
export function shifted(curve: CurveSettings, sun: SunDay) {
  return {
    sunrise: addMinutes(sun.sunrise, curve.sunriseOffsetMinutes).getTime(),
    sunset: addMinutes(sun.sunset, curve.sunsetOffsetMinutes).getTime(),
  };
}

// v1 had one function each for temperature and brightness, the same apart
// from their ends.
function along(
  curve: CurveSettings,
  sun: SunDay,
  now: Date,
  low: number,
  high: number,
) {
  const { sunrise, sunset } = shifted(curve, sun);
  const peak = peakAt(curve, sun).getTime();
  const current = now.getTime();
  if (current <= sunrise || current >= sunset) {
    return low;
  }
  if (current <= peak) {
    return interpolate(low, high, current, sunrise, peak);
  }
  return interpolate(high, low, current, peak, sunset);
}

function interpolate(
  from: number,
  to: number,
  current: number,
  start: number,
  end: number,
) {
  if (end <= start) {
    return Math.round(to);
  }
  const progress = Math.min(1, Math.max(0, (current - start) / (end - start)));
  const eased = progress * progress * (3 - 2 * progress);
  return Math.round(from + (to - from) * eased);
}

export function kelvinToMired(kelvin: number) {
  return Math.round(1_000_000 / kelvin);
}

export function miredToKelvin(mired: number) {
  return Math.round(1_000_000 / mired);
}

/** A colour temperature within what a light can show, in mireds. */
export function clampMired(mired: number, range: { min: number; max: number }) {
  return Math.min(range.max, Math.max(range.min, mired));
}

export function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}
