import type { Forecast, ForecastHour } from "@meetsanctum/app-sdk";

// A forecast for Weather's tests: a wet day in Zurich fetched just before
// ten in the morning there, 09:00 UTC, with two days of hours from eight.
// It rains until 16:00 there and is overcast after; the nights are clear.

export const fetchedAt = new Date("2026-10-29T08:58:00Z");
/** Ten in the morning in Zurich. */
export const morning = new Date("2026-10-29T09:00:00Z");

const hourMs = 3_600_000;
const firstHour = Date.parse("2026-10-29T07:00:00Z");

/** The hour that starts so many hours after eight in the morning in Zurich. */
export function hourAt(index: number): ForecastHour {
  const time = new Date(firstHour + index * hourMs);
  const utcHour = time.getUTCHours();
  const isFirstDay = index < 17;
  const isRaining = isFirstDay && utcHour < 15;
  const isDay = utcHour >= 6 && utcHour < 16;
  return {
    time: time.toISOString(),
    // Warmest in the afternoon, coldest before sunrise.
    temperatureC: 8 + 4 * Math.cos(((utcHour - 13) / 24) * 2 * Math.PI),
    weatherCode: isRaining ? 63 : isDay || isFirstDay ? 3 : 0,
    isDay,
    precipitationProbability: isRaining ? 80 : isFirstDay ? 15 : 0,
    precipitationMm: isRaining ? 0.9 : 0,
    snowfallCm: 0,
  };
}

const day = (
  date: string,
  max: number,
  min: number,
  code: number,
  rain: number,
) => ({
  date,
  temperatureMaxC: max,
  temperatureMinC: min,
  precipitationProbabilityMax: rain,
  weatherCode: code,
  precipitationSumMm: rain >= 50 ? 6.5 : 0,
  snowfallSumCm: 0,
  uvIndexMax: 1.4,
});

export const forecast: Forecast = {
  timeZone: "Europe/Zurich",
  updatedAt: fetchedAt.toISOString(),
  current: {
    temperatureC: 11.4,
    weatherCode: 63,
    isDay: true,
    apparentTemperatureC: 9.6,
    relativeHumidity: 74,
    dewPointC: 6.9,
    windSpeedKmh: 14.2,
    windGustsKmh: 22.3,
    windDirection: 268,
    uvIndex: 1.2,
  },
  days: [
    day("2026-10-28", 13, 5, 3, 10),
    day("2026-10-29", 14.2, 6.1, 63, 80),
    day("2026-10-30", 12.8, 7.4, 2, 10),
    day("2026-10-31", 10, 2, 0, 0),
    day("2026-11-01", 16, 8, 61, 60),
  ],
  hours: Array.from({ length: 48 }, (_, index) => hourAt(index)),
};

/** The same forecast with other hours, from eight in the morning in Zurich. */
export const withHours = (
  change: (hour: ForecastHour, index: number) => Partial<ForecastHour>,
): Forecast => ({
  ...forecast,
  hours: forecast.hours!.map((hour, index) => ({
    ...hour,
    ...change(hour, index),
  })),
});
