import type {
  Forecast,
  ForecastDay,
  SunDay,
  SunTimes,
} from "@meetsanctum/app-sdk";

// The home's days: which is today in its time zone, and the sun and the
// forecast's days from it on, for Weather's card and its own page.

/**
 * The home's date now, such as 2026-10-29, in its time zone: from its
 * parts, since no locale promises that order.
 */
export function homeDate(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((each) => each.type === type)?.value ?? "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

/** The sun on the home's today, which a state kept from yesterday has too. */
export function sunToday(sun: SunTimes, now = new Date()): SunDay | undefined {
  const today = homeDate(sun.timeZone, now);
  return sun.days.find((day) => day.date === today);
}

/** The forecast's days from the home's today on: one kept while offline may have run past some. */
export function daysFromToday(forecast: Forecast, now = new Date()) {
  const today = homeDate(forecast.timeZone, now);
  return forecast.days.filter((day: ForecastDay) => day.date >= today);
}

/** Where a day's bar runs on a scale: where it starts and how wide it is, each from 0 to 1. */
export type TemperatureSpan = { start: number; width: number };

/**
 * Each day's low to high on one scale, from the coldest low to the warmest
 * high of them all, so the days' bars compare. A day without both has none.
 */
export function temperatureSpans(
  days: ForecastDay[],
): (TemperatureSpan | null)[] {
  const known = days.flatMap((day) =>
    day.temperatureMinC === null || day.temperatureMaxC === null
      ? []
      : [day.temperatureMinC, day.temperatureMaxC],
  );
  const coldest = Math.min(...known);
  const span = Math.max(...known) - coldest;
  return days.map((day) => {
    if (day.temperatureMinC === null || day.temperatureMaxC === null) {
      return null;
    }
    // Days all at one temperature fill the scale.
    if (span === 0) return { start: 0, width: 1 };
    const low = Math.min(day.temperatureMinC, day.temperatureMaxC);
    const high = Math.max(day.temperatureMinC, day.temperatureMaxC);
    return { start: (low - coldest) / span, width: (high - low) / span };
  });
}
