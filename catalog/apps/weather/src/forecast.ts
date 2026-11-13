import type { AppContext, Forecast, HomeLocation } from "@meetsanctum/app-sdk";
import { z } from "zod";

// The forecast for the home from Open-Meteo: the weather now and ten days,
// in Celsius and the home's time zone. Weather reaches Open-Meteo through
// the core (ctx.net.fetch), at the one host it holds net:api.open-meteo.com
// for.

export const openMeteoHost = "api.open-meteo.com";

const forecastDays = 10;
const timeoutMs = 5_000;

const daily = [
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_probability_max",
  "weather_code",
] as const;
const current = ["temperature_2m", "weather_code", "is_day"] as const;

const values = z.array(z.number().nullable());
const answer = z.object({
  current: z
    .object({
      temperature_2m: z.number().nullable().optional(),
      weather_code: z.number().nullable().optional(),
      is_day: z.number().nullable().optional(),
    })
    .optional(),
  daily: z.object({
    time: z.array(z.iso.date()),
    temperature_2m_max: values,
    temperature_2m_min: values,
    precipitation_probability_max: values,
    weather_code: values.optional(),
  }),
});

export async function fetchForecast(
  net: AppContext["net"],
  location: HomeLocation,
  now: Date,
): Promise<Forecast> {
  const url = new URL(`https://${openMeteoHost}/v1/forecast`);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("current", current.join(","));
  url.searchParams.set("daily", daily.join(","));
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("timezone", location.timeZone);
  url.searchParams.set("forecast_days", String(forecastDays));

  const response = await net.fetch({ url: url.toString(), timeoutMs });
  if (response.status !== 200) {
    throw new Error(`Open-Meteo answered ${response.status}`);
  }
  const parsed = answer.parse(JSON.parse(response.body));
  const code = (value: number | null | undefined) =>
    value === null || value === undefined ? null : Math.round(value);
  return {
    timeZone: location.timeZone,
    updatedAt: now.toISOString(),
    current: parsed.current
      ? {
          temperatureC: parsed.current.temperature_2m ?? null,
          weatherCode: code(parsed.current.weather_code),
          isDay:
            parsed.current.is_day === null ||
            parsed.current.is_day === undefined
              ? null
              : parsed.current.is_day === 1,
        }
      : null,
    days: parsed.daily.time.map((date, index) => ({
      date,
      temperatureMaxC: parsed.daily.temperature_2m_max[index] ?? null,
      temperatureMinC: parsed.daily.temperature_2m_min[index] ?? null,
      precipitationProbabilityMax:
        parsed.daily.precipitation_probability_max[index] ?? null,
      weatherCode: code(parsed.daily.weather_code?.[index]),
    })),
  };
}
