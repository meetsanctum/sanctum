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

/** A column's time in the forecast zone, with whole hours shortened to 4 PM in 12-hour mode. */
export function hourLabel(clock: HomeClock, instant: string) {
  const at = Date.parse(instant);
  return clock.hourCycle === "12h" && clock.parts(at).minute === 0
    ? clock.hourText(at)
    : clock.timeText(at);
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
  if (there.date(at) === there.date(now)) return `Updated ${time}`;
  const date = new Intl.DateTimeFormat(undefined, {
    timeZone: there.timeZone,
    day: "numeric",
    month: "short",
  }).format(at);
  return `Updated ${date}, ${time}`;
}
