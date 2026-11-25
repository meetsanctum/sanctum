import type { AppContext, Forecast, HomeLocation } from "@meetsanctum/app-sdk";
import { zonedDateToUtc } from "@meetsanctum/app-sdk/clock";
import { z } from "zod";

// The forecast for the home from Open-Meteo: the weather now, the next two
// days hour by hour and ten days, in Celsius, millimetres, km/h and the
// home's time zone. Weather reaches Open-Meteo through the core
// (ctx.net.fetch), at the one host it holds net:api.open-meteo.com for.

export const openMeteoHost = "api.open-meteo.com";

const forecastDays = 10;
const forecastHours = 48;
const timeoutMs = 5_000;
const hourMs = 3_600_000;

const current = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "dew_point_2m",
  "weather_code",
  "is_day",
  "wind_speed_10m",
  "wind_gusts_10m",
  "wind_direction_10m",
  "uv_index",
] as const;
const hourly = [
  "temperature_2m",
  "weather_code",
  "is_day",
  "precipitation_probability",
  "precipitation",
  "snowfall",
] as const;
const daily = [
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_probability_max",
  "weather_code",
  "precipitation_sum",
  "snowfall_sum",
  "uv_index_max",
] as const;

const value = z.number().nullable().optional();
const values = z.array(z.number().nullable());
// An hour as Open-Meteo writes it, in the home's time zone: 2026-10-29T10:00.
const localHour = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const answer = z.object({
  /** How far the home's time is ahead of UTC as the forecast starts. */
  utc_offset_seconds: z.number().optional(),
  current: z
    .object({
      temperature_2m: value,
      apparent_temperature: value,
      relative_humidity_2m: value,
      dew_point_2m: value,
      weather_code: value,
      is_day: value,
      wind_speed_10m: value,
      wind_gusts_10m: value,
      wind_direction_10m: value,
      uv_index: value,
    })
    .optional(),
  hourly: z
    .object({
      time: z.array(localHour),
      temperature_2m: values.optional(),
      weather_code: values.optional(),
      is_day: values.optional(),
      precipitation_probability: values.optional(),
      precipitation: values.optional(),
      snowfall: values.optional(),
    })
    .optional(),
  daily: z.object({
    time: z.array(z.iso.date()),
    temperature_2m_max: values,
    temperature_2m_min: values,
    precipitation_probability_max: values,
    weather_code: values.optional(),
    precipitation_sum: values.optional(),
    snowfall_sum: values.optional(),
    uv_index_max: values.optional(),
  }),
});

const code = (value: number | null | undefined) =>
  value === null || value === undefined ? null : Math.round(value);
const flag = (value: number | null | undefined) =>
  value === null || value === undefined ? null : value === 1;
// A number kept within what its unit allows, such as a percentage.
const within = (value: number | null | undefined, min: number, max: number) =>
  value === null || value === undefined
    ? null
    : Math.min(max, Math.max(min, value));

// When the first of the hours starts. Open-Meteo counts them one real hour
// after another and writes each in the home's time zone, so only the first
// is read as a local time: across a change of the clocks the rest stay an
// hour apart.
function firstHour(
  time: string,
  timeZone: string,
  utcOffsetSeconds: number | undefined,
) {
  if (utcOffsetSeconds !== undefined) {
    return Date.parse(`${time}:00Z`) - utcOffsetSeconds * 1000;
  }
  const [date, clock] = time.split("T") as [string, string];
  const [hour, minute] = clock.split(":").map(Number) as [number, number];
  return zonedDateToUtc(date, hour, minute, timeZone).getTime();
}

export async function fetchForecast(
  net: AppContext["net"],
  location: HomeLocation,
  now: Date,
): Promise<Forecast> {
  const url = new URL(`https://${openMeteoHost}/v1/forecast`);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("current", current.join(","));
  url.searchParams.set("hourly", hourly.join(","));
  url.searchParams.set("daily", daily.join(","));
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("wind_speed_unit", "kmh");
  url.searchParams.set("precipitation_unit", "mm");
  url.searchParams.set("timezone", location.timeZone);
  url.searchParams.set("forecast_days", String(forecastDays));
  url.searchParams.set("forecast_hours", String(forecastHours));

  const response = await net.fetch({ url: url.toString(), timeoutMs });
  if (response.status !== 200) {
    throw new Error(`Open-Meteo answered ${response.status}`);
  }
  const parsed = answer.parse(JSON.parse(response.body));
  const hours = parsed.hourly;
  const start = hours?.time[0]
    ? firstHour(hours.time[0], location.timeZone, parsed.utc_offset_seconds)
    : 0;
  return {
    timeZone: location.timeZone,
    updatedAt: now.toISOString(),
    current: parsed.current
      ? {
          temperatureC: parsed.current.temperature_2m ?? null,
          weatherCode: code(parsed.current.weather_code),
          isDay: flag(parsed.current.is_day),
          apparentTemperatureC: parsed.current.apparent_temperature ?? null,
          relativeHumidity: within(parsed.current.relative_humidity_2m, 0, 100),
          dewPointC: parsed.current.dew_point_2m ?? null,
          windSpeedKmh: parsed.current.wind_speed_10m ?? null,
          windGustsKmh: parsed.current.wind_gusts_10m ?? null,
          windDirection: within(parsed.current.wind_direction_10m, 0, 360),
          uvIndex: parsed.current.uv_index ?? null,
        }
      : null,
    days: parsed.daily.time.map((date, index) => ({
      date,
      temperatureMaxC: parsed.daily.temperature_2m_max[index] ?? null,
      temperatureMinC: parsed.daily.temperature_2m_min[index] ?? null,
      precipitationProbabilityMax:
        parsed.daily.precipitation_probability_max[index] ?? null,
      weatherCode: code(parsed.daily.weather_code?.[index]),
      precipitationSumMm: parsed.daily.precipitation_sum?.[index] ?? null,
      snowfallSumCm: parsed.daily.snowfall_sum?.[index] ?? null,
      uvIndexMax: parsed.daily.uv_index_max?.[index] ?? null,
    })),
    ...(hours && {
      hours: hours.time.slice(0, forecastHours).map((_, index) => ({
        time: new Date(start + index * hourMs).toISOString(),
        temperatureC: hours.temperature_2m?.[index] ?? null,
        weatherCode: code(hours.weather_code?.[index]),
        isDay: flag(hours.is_day?.[index]),
        precipitationProbability: within(
          hours.precipitation_probability?.[index],
          0,
          100,
        ),
        precipitationMm: hours.precipitation?.[index] ?? null,
        snowfallCm: hours.snowfall?.[index] ?? null,
      })),
    }),
  };
}
