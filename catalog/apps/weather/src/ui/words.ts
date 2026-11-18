import type { TemperatureUnit } from "@meetsanctum/app-sdk";
import { formatTemperature } from "@meetsanctum/ui-sdk";

import { homeDate } from "../days";

// How Weather's page writes temperatures, times and days: whole degrees in
// the unit the home shows, and times in the home's time zone, as this
// device writes them.

/** Whole degrees, as a forecast shows them, the unit clear from the page; a dash while there is none. */
export function degrees(celsius: number | null, unit: TemperatureUnit) {
  return formatTemperature(celsius, unit, { compact: true, whole: true });
}

const at = (
  instant: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
) =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(
    new Date(instant),
  );

/** A time of day, such as 16:00. */
export function clock(instant: string, timeZone: string) {
  return at(instant, timeZone, { hour: "numeric", minute: "2-digit" });
}

/**
 * An hour above its column: 16:00 where the device counts 24 hours, and
 * 4 PM where it counts twelve, which a column has the room for.
 */
export function hourLabel(instant: string, timeZone: string) {
  const countsTwelve = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
  }).resolvedOptions().hour12;
  return at(
    instant,
    timeZone,
    countsTwelve ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" },
  );
}

/** The short weekday of an instant in the home, such as Tue. */
export function weekdayAt(instant: string, timeZone: string) {
  return at(instant, timeZone, { weekday: "short" });
}

/** The short weekday of one of the home's dates, such as Tue for 2026-11-17. */
export function weekdayOf(date: string) {
  return at(`${date}T12:00:00Z`, "UTC", { weekday: "short" });
}

/**
 * When the forecast was fetched: its time, and its day too once that isn't
 * the home's today, so one kept while offline says how old it is.
 */
export function updatedWords(updatedAt: string, timeZone: string, now: Date) {
  const isToday =
    homeDate(timeZone, new Date(updatedAt)) === homeDate(timeZone, now);
  const time = clock(updatedAt, timeZone);
  return isToday
    ? `Updated ${time}`
    : `Updated ${at(updatedAt, timeZone, { day: "numeric", month: "short" })}, ${time}`;
}
