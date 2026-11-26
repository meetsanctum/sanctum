import type {
  Forecast,
  ForecastDay,
  SunDay,
  SunTimes,
} from "@meetsanctum/app-sdk";
import type { HomeClock } from "@meetsanctum/app-sdk/clock";

// The home's days: which is today, and the sun and the forecast's days from
// it on, for Weather's card and its own page. The sun and the forecast are
// read in the time zone they were fetched in, which the home's matches until
// the household moves it and Weather fetches them again.

/** The date at an instant, such as 2026-10-29, in the zone data was fetched in. */
export function dateIn(
  clock: HomeClock,
  timeZone: string,
  at: Date | number = clock.now(),
) {
  return clock.withTimeZone(timeZone).date(at);
}

/** The sun on the home's today, which a state kept from yesterday has too. */
export function sunToday(
  clock: HomeClock,
  sun: SunTimes,
  now = clock.now(),
): SunDay | undefined {
  const today = dateIn(clock, sun.timeZone, now);
  return sun.days.find((day) => day.date === today);
}

/** The forecast's days from the home's today on: one kept while offline may have run past some. */
export function daysFromToday(
  clock: HomeClock,
  forecast: Forecast,
  now = clock.now(),
) {
  const today = dateIn(clock, forecast.timeZone, now);
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
