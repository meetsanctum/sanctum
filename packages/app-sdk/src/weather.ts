import { z } from "zod";

import { defineEntityType } from "./entities.js";
import { isTimeZone } from "./places.js";

// The standard entity types for the sun and the weather, defined by the core
// so that any app may provide them and any app read them with
// entities.read:sun and entities.read:weather.forecast. Weather
// (sanctum.weather) provides both for the home, once someone has set where
// it is. Instants are ISO, in UTC; dates are the home's, in its time zone.

const instant = z.iso.datetime();
const date = z.iso.date();
const timeZone = z
  .string()
  .min(1)
  .max(64)
  .refine(isTimeZone, "use a known time zone");

export const sunDaySchema = z.object({
  /** Such as 2026-10-29. */
  date,
  /** Null on a day the sun does not rise or set there, as in a polar summer or winter. */
  sunrise: instant.nullable(),
  sunset: instant.nullable(),
  /** When the sun is highest. */
  solarNoon: instant,
});
export type SunDay = z.infer<typeof sunDaySchema>;

// Nothing in it depends on the time of day, so it changes once a day, at the
// home's midnight, or when the home moves.
export const sunTimesSchema = z.object({
  /** The home's date today, such as 2026-10-29. */
  date,
  /** The home's IANA time zone, such as Europe/Zurich. */
  timeZone,
  /**
   * Day by day from the home's yesterday on: at least yesterday, today and
   * tomorrow, so that a time some hours before or after a sunrise or sunset
   * is found on either side of midnight.
   */
  days: z.array(sunDaySchema).min(3).max(31),
});
export type SunTimes = z.infer<typeof sunTimesSchema>;

/** One day's sun: today's, unless another of its dates is asked for. */
export function sunDay(sun: SunTimes, date = sun.date): SunDay | undefined {
  return sun.days.find((day) => day.date === date);
}

export const sunType = defineEntityType({
  id: "sun",
  title: "Sun",
  state: sunTimesSchema,
  standard: true,
});

export const forecastDaySchema = z.object({
  /** Such as 2026-10-29. */
  date,
  temperatureMaxC: z.number().nullable(),
  temperatureMinC: z.number().nullable(),
  /** The highest chance of rain or snow that day, in percent. */
  precipitationProbabilityMax: z.number().min(0).max(100).nullable(),
  /** The WMO weather code (Open-Meteo's weather_code), such as 61 for light rain. */
  weatherCode: z.number().int().nullable(),
});
export type ForecastDay = z.infer<typeof forecastDaySchema>;

export const forecastSchema = z.object({
  timeZone,
  /** When the forecast was fetched. */
  updatedAt: instant,
  /** The weather now, as of updatedAt. */
  current: z
    .object({
      temperatureC: z.number().nullable(),
      weatherCode: z.number().int().nullable(),
      /** Whether the sun is up, for the icon. */
      isDay: z.boolean().nullable(),
    })
    .nullable(),
  /** Day by day from the home's today on, up to 16 days. */
  days: z.array(forecastDaySchema).max(16),
});
export type Forecast = z.infer<typeof forecastSchema>;

export const forecastType = defineEntityType({
  id: "weather.forecast",
  title: "Forecast",
  state: forecastSchema,
  standard: true,
});
