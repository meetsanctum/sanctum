import type { SunDay } from "@meetsanctum/app-sdk";

// The sun's day on Weather's page: how long it is up, and where it is on
// the arc the page draws from sunrise to sunset.

export type SunPath = {
  sunrise: string;
  sunset: string;
  /** From sunrise to sunset, in whole minutes. */
  daylightMinutes: number;
  /** How far the sun is from sunrise to sunset, from 0 to 1; at either end while it is down. */
  progress: number;
  isUp: boolean;
};

/** The sun's path on a day it rises and sets; none on a day it does neither or only one. */
export function sunPath(
  day: SunDay | undefined,
  now = new Date(),
): SunPath | null {
  if (!day?.sunrise || !day.sunset) return null;
  const rise = Date.parse(day.sunrise);
  const set = Date.parse(day.sunset);
  if (set <= rise) return null;
  const progress = (now.getTime() - rise) / (set - rise);
  return {
    sunrise: day.sunrise,
    sunset: day.sunset,
    daylightMinutes: Math.round((set - rise) / 60_000),
    progress: Math.min(1, Math.max(0, progress)),
    isUp: progress > 0 && progress < 1,
  };
}

/** A length of daylight as people read it, such as "9 h 17 min". */
export function daylightWords(minutes: number) {
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * The arc the page draws, in its drawing's own units, 260 wide and 70
 * high: a curve from sunrise at the left of the horizon, over its control
 * point, to sunset at the right.
 */
export const sunArc = {
  width: 260,
  height: 70,
  horizon: 62,
  start: { x: 10, y: 62 },
  control: { x: 130, y: -40 },
  end: { x: 250, y: 62 },
} as const;

/** Where the sun is on the arc, `progress` of the way along it. */
export function arcPoint(progress: number) {
  const { start, control, end } = sunArc;
  const rest = 1 - progress;
  const along = (from: number, over: number, to: number) =>
    Math.round(
      (rest * rest * from +
        2 * rest * progress * over +
        progress * progress * to) *
        10,
    ) / 10;
  return {
    x: along(start.x, control.x, end.x),
    y: along(start.y, control.y, end.y),
  };
}
