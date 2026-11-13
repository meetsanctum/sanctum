import { z } from "zod";

import {
  addMinutes,
  brightnessPercent,
  colorTemperatureKelvin,
  peakAt,
  shifted,
  type CurveSettings,
} from "./curve.js";
import { naturalLightSettings } from "./settings.js";
import type { HomeSun } from "./sun.js";

// Today's curve as the app's page draws it: points every 15 minutes from an
// hour before sunrise to an hour after sunset, with the moments that shape
// it. The page writes times as its device does.

const instant = z.iso.datetime();

export const preview = z.object({
  date: z.string(),
  timeZone: z.string(),
  curve: naturalLightSettings,
  /** What lights that follow it are set to now. */
  now: z.object({ at: instant, kelvin: z.number(), brightness: z.number() }),
  /** Sunrise and sunset with the curve's offsets. */
  sunrise: instant,
  sunset: instant,
  solarNoon: instant,
  peak: instant,
  points: z.array(
    z.object({ at: instant, kelvin: z.number(), brightness: z.number() }),
  ),
});
export type Preview = z.infer<typeof preview>;

const step = 15;

export function previewOf(
  curve: CurveSettings,
  sun: HomeSun,
  now: Date,
): Preview {
  const { sunrise, sunset } = shifted(curve, sun);
  const peak = peakAt(curve, sun).getTime();
  // Offsets can cross on short winter days. Keep a drawable interval
  // around all the markers even when the curve stays at its night values.
  const start = addMinutes(
    new Date(Math.min(sunrise, sunset, peak)),
    -60,
  ).getTime();
  const end = addMinutes(
    new Date(Math.max(sunrise, sunset, peak)),
    60,
  ).getTime();
  const instants = new Set([now.getTime(), peak, sunrise, sunset]);
  for (let at = start; at <= end; at += step * 60_000) {
    instants.add(at);
  }
  const point = (at: Date) => ({
    at: at.toISOString(),
    kelvin: colorTemperatureKelvin(curve, sun, at),
    brightness: brightnessPercent(curve, sun, at),
  });
  return {
    date: sun.date,
    timeZone: sun.timeZone,
    curve,
    now: point(now),
    sunrise: new Date(sunrise).toISOString(),
    sunset: new Date(sunset).toISOString(),
    solarNoon: sun.solarNoon.toISOString(),
    peak: new Date(peak).toISOString(),
    points: [...instants]
      .filter((at) => at >= start && at <= end)
      .sort((a, b) => a - b)
      .map((at) => point(new Date(at))),
  };
}
