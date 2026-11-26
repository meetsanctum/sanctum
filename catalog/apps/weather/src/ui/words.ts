import type { TemperatureUnit } from "@meetsanctum/app-sdk";
import type { HomeClock } from "@meetsanctum/app-sdk/clock";
import { formatTemperature } from "@meetsanctum/ui-sdk";

// How Weather's page writes temperatures, times and days: whole degrees in
// the unit the home shows, and times as the home writes them, 16:00 or
// 4:00 PM, in the time zone the forecast or the sun was fetched in.

/** Whole degrees, as a forecast shows them, the unit clear from the page; a dash while there is none. */
export function degrees(celsius: number | null, unit: TemperatureUnit) {
  return formatTemperature(celsius, unit, { compact: true, whole: true });
}

/** A time of day, such as 16:00, or 4:00 PM with 12 hours. */
export function timeAt(clock: HomeClock, instant: string, timeZone: string) {
  return clock.withTimeZone(timeZone).timeText(Date.parse(instant));
}

/** An hour above its column: 16:00, or 4 PM with 12 hours, which a column has the room for. */
export function hourLabel(clock: HomeClock, instant: string, timeZone: string) {
  return clock.withTimeZone(timeZone).hourText(Date.parse(instant));
}

/** The short weekday of an instant in the home, such as Tue. */
export function weekdayAt(clock: HomeClock, instant: string, timeZone: string) {
  return clock.withTimeZone(timeZone).weekdayText(Date.parse(instant));
}

/** The short weekday of one of the home's dates, such as Tue for 2026-11-17. */
export function weekdayOf(clock: HomeClock, date: string) {
  return clock.withTimeZone("UTC").weekdayText(Date.parse(`${date}T12:00:00Z`));
}

/**
 * When the forecast was fetched: its time, and its day too once that isn't
 * the home's today, so one kept while offline says how old it is.
 */
export function updatedWords(
  clock: HomeClock,
  updatedAt: string,
  timeZone: string,
  now: Date,
) {
  const there = clock.withTimeZone(timeZone);
  const at = Date.parse(updatedAt);
  const time = there.timeText(at);
  return there.date(at) === there.date(now)
    ? `Updated ${time}`
    : `Updated ${there.dayText(at)}, ${time}`;
}
