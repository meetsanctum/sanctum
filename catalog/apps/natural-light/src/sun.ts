import { sunDay, sunTimes, type HomeLocation } from "@meetsanctum/app-sdk";

import type { SunDay } from "./curve.js";

// The sun on the home's day, from app-sdk's sunTimes and where the home is:
// the same times as Weather's `sun` entity, so natural light agrees with it
// without needing it. They are the home's own day's, whatever the host's
// time zone, and count the home's elevation.

export type HomeSun = SunDay & {
  /** The home's date, such as 2026-10-29. */
  date: string;
  timeZone: string;
};

/**
 * Today's sunrise, sunset and solar noon at the home, or null on a day
 * without both, as in a polar summer or winter, when lights are left alone.
 */
export function sunToday(location: HomeLocation, now: Date): HomeSun | null {
  const today = sunDay(sunTimes(location, now));
  if (!today?.sunrise || !today.sunset) {
    return null;
  }
  return {
    date: today.date,
    timeZone: location.timeZone,
    sunrise: new Date(today.sunrise),
    sunset: new Date(today.sunset),
    solarNoon: new Date(today.solarNoon),
  };
}
