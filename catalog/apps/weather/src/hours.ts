import type { Forecast, ForecastHour } from "@meetsanctum/app-sdk";
import type { HomeClock } from "@meetsanctum/app-sdk/clock";

// The forecast hour by hour, as Weather's page shows it: the weather now,
// the hours from this one on, the columns of the next 24 hours and the line
// their temperatures draw.

const hourMs = 3_600_000;
// Weather fetches every hour, so what it fetched is the weather now for the
// two hours after. Older than that, the hour it is has the better word.
const currentForMs = 2 * hourMs;

/** The forecast's hours from the one it is now: one kept while offline may have run past some. */
export function hoursFromNow(forecast: Forecast, now = new Date()) {
  const from = now.getTime() - hourMs;
  return (forecast.hours ?? []).filter((hour) => Date.parse(hour.time) > from);
}

/** The forecast's hours from the one it is now to the home's midnight. */
export function hoursLeftToday(
  clock: HomeClock,
  forecast: Forecast,
  now = clock.now(),
) {
  const there = clock.withTimeZone(forecast.timeZone);
  const today = there.date(now);
  return hoursFromNow(forecast, now).filter(
    (hour) => there.date(Date.parse(hour.time)) === today,
  );
}

export type WeatherNow = {
  temperatureC: number | null;
  weatherCode: number | null;
  isDay: boolean | null;
  apparentTemperatureC: number | null;
  /** In percent. */
  relativeHumidity: number | null;
  dewPointC: number | null;
  windSpeedKmh: number | null;
  windGustsKmh: number | null;
  /** Where the wind comes from, in degrees clockwise from north. */
  windDirection: number | null;
  uvIndex: number | null;
};

const unknown: WeatherNow = {
  temperatureC: null,
  weatherCode: null,
  isDay: null,
  apparentTemperatureC: null,
  relativeHumidity: null,
  dewPointC: null,
  windSpeedKmh: null,
  windGustsKmh: null,
  windDirection: null,
  uvIndex: null,
};

/**
 * The weather now: as it was fetched while that is recent, and from a
 * forecast kept longer, what it says of the hour it is, which knows the
 * temperature and the sky but no wind, humidity or UV. A forecast without
 * that hour keeps only the temperature and sky it fetched.
 */
export function weatherNow(forecast: Forecast, now = new Date()): WeatherNow {
  const hour = hoursFromNow(forecast, now)[0];
  const isRecent =
    now.getTime() - Date.parse(forecast.updatedAt) < currentForMs;
  const current = forecast.current;
  if (current && isRecent) {
    return {
      temperatureC: current.temperatureC,
      weatherCode: current.weatherCode,
      isDay: current.isDay,
      apparentTemperatureC: current.apparentTemperatureC ?? null,
      relativeHumidity: current.relativeHumidity ?? null,
      dewPointC: current.dewPointC ?? null,
      windSpeedKmh: current.windSpeedKmh ?? null,
      windGustsKmh: current.windGustsKmh ?? null,
      windDirection: current.windDirection ?? null,
      uvIndex: current.uvIndex ?? null,
    };
  }
  const kept = hour ?? current;
  if (!kept) return unknown;
  return {
    ...unknown,
    temperatureC: kept.temperatureC,
    weatherCode: kept.weatherCode,
    isDay: kept.isDay,
  };
}

export type HourColumn = Pick<
  ForecastHour,
  "time" | "temperatureC" | "weatherCode" | "isDay" | "precipitationProbability"
> & {
  /** The first, which is the hour it is. */
  isNow: boolean;
  /** The first of the home's next day. */
  startsDay: boolean;
};

/**
 * The next hours as columns: `count` of them, `every` so many hours from
 * the hour it is, or as many as the forecast still has. The first says the
 * weather now, so it agrees with what the page says of now.
 */
export function hourColumns(
  clock: HomeClock,
  forecast: Forecast,
  options: { count: number; every: number },
  now = clock.now(),
): HourColumn[] {
  const hours = hoursFromNow(forecast, now)
    .filter((_, index) => index % options.every === 0)
    .slice(0, options.count);
  const there = clock.withTimeZone(forecast.timeZone);
  const dates = hours.map((hour) => there.date(Date.parse(hour.time)));
  const current = weatherNow(forecast, now);
  return hours.map((hour, index) => ({
    time: hour.time,
    temperatureC: index === 0 ? current.temperatureC : hour.temperatureC,
    weatherCode: index === 0 ? current.weatherCode : hour.weatherCode,
    isDay: index === 0 ? current.isDay : hour.isDay,
    precipitationProbability: hour.precipitationProbability,
    isNow: index === 0,
    startsDay: index > 0 && dates[index] !== dates[index - 1],
  }));
}

export type Plot = {
  /** An SVG polyline's points, one per column that has a temperature. */
  points: string;
  /** Where the first column's point is, for its dot. */
  first: { x: number; y: number } | null;
};

/**
 * The line some columns' temperatures draw: a point at the middle of each
 * column, `column` wide, the warmest `inset` below the top of `height` and
 * the coldest as far above its foot. Temperatures all the same run along
 * the middle.
 */
export function plotOf(
  temperatures: (number | null)[],
  size: { column: number; height: number; inset: number },
): Plot {
  const known = temperatures.filter((each) => each !== null);
  const coldest = Math.min(...known);
  const span = Math.max(...known) - coldest;
  const room = size.height - 2 * size.inset;
  const placed = temperatures.map((temperature, index) =>
    temperature === null
      ? null
      : {
          x: size.column * (index + 0.5),
          y:
            Math.round(
              (size.inset +
                (span === 0 ? 0.5 : 1 - (temperature - coldest) / span) *
                  room) *
                10,
            ) / 10,
        },
  );
  return {
    points: placed
      .filter((point) => point !== null)
      .map((point) => `${point.x},${point.y}`)
      .join(" "),
    first: placed[0] ?? null,
  };
}
