import { forecastType, type Forecast } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { fetchForecast } from "../src/forecast.js";
import app from "../src/index.js";
import { answer, fakeCore, openMeteoAnswer } from "./fake-core.js";

// The forecast from Open-Meteo.

const zurich = {
  latitude: 47.3769,
  longitude: 8.5417,
  elevation: 408,
  timeZone: "Europe/Zurich",
};
const now = new Date("2026-10-29T09:00:00Z");

describe("the forecast", () => {
  it("asks Open-Meteo for the weather now, two days of hours and ten days, in the home's time zone", async () => {
    const { ctx, state } = fakeCore(app);
    state.internet = async () => answer(openMeteoAnswer);

    const forecast = await fetchForecast(ctx.net, zurich, now);

    const [request] = state.requests;
    const url = new URL(request!.url);
    expect(url.origin + url.pathname).toBe(
      "https://api.open-meteo.com/v1/forecast",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: "47.3769",
      longitude: "8.5417",
      current:
        "temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,weather_code,is_day,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index",
      hourly:
        "temperature_2m,weather_code,is_day,precipitation_probability,precipitation,snowfall",
      daily:
        "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,precipitation_sum,snowfall_sum,uv_index_max",
      temperature_unit: "celsius",
      wind_speed_unit: "kmh",
      precipitation_unit: "mm",
      timezone: "Europe/Zurich",
      forecast_days: "10",
      forecast_hours: "48",
    });
    expect(request!.timeoutMs).toBe(5_000);
    expect(forecast).toEqual({
      timeZone: "Europe/Zurich",
      updatedAt: "2026-10-29T09:00:00.000Z",
      current: {
        temperatureC: 11.4,
        weatherCode: 2,
        isDay: true,
        apparentTemperatureC: 9.8,
        relativeHumidity: 74,
        dewPointC: 6.9,
        windSpeedKmh: 14.2,
        windGustsKmh: 22.3,
        windDirection: 268,
        uvIndex: 1.2,
      },
      days: [
        {
          date: "2026-10-29",
          temperatureMaxC: 14.2,
          temperatureMinC: 6.1,
          precipitationProbabilityMax: 10,
          weatherCode: 2,
          precipitationSumMm: 0.4,
          snowfallSumCm: 0,
          uvIndexMax: 2.4,
        },
        {
          date: "2026-10-30",
          temperatureMaxC: 12.8,
          temperatureMinC: 7.4,
          precipitationProbabilityMax: 65,
          weatherCode: 61,
          precipitationSumMm: 6.5,
          snowfallSumCm: 0,
          uvIndexMax: 1.1,
        },
      ],
      hours: [
        {
          time: "2026-10-29T09:00:00.000Z",
          temperatureC: 11.2,
          weatherCode: 2,
          isDay: true,
          precipitationProbability: 10,
          precipitationMm: 0,
          snowfallCm: 0,
        },
        {
          time: "2026-10-29T10:00:00.000Z",
          temperatureC: 12.1,
          weatherCode: 3,
          isDay: true,
          precipitationProbability: 20,
          precipitationMm: 0,
          snowfallCm: 0,
        },
        {
          time: "2026-10-29T11:00:00.000Z",
          temperatureC: 13,
          weatherCode: 61,
          isDay: true,
          precipitationProbability: 65,
          precipitationMm: 0.4,
          snowfallCm: 0,
        },
      ],
    });
    expect(forecastType.state.parse(forecast)).toEqual(forecast);
  });

  it("keeps what Open-Meteo leaves out as unknown", async () => {
    const { ctx, state } = fakeCore(app);
    state.internet = async () =>
      answer({
        current: { temperature_2m: 11.4, relative_humidity_2m: 104 },
        hourly: { time: ["2026-10-29T10:00"], temperature_2m: [null] },
        daily: {
          time: ["2026-10-29"],
          temperature_2m_max: [null],
          temperature_2m_min: [6.1],
          precipitation_probability_max: [],
        },
      });

    const forecast = await fetchForecast(ctx.net, zurich, now);

    expect(forecast).toEqual({
      timeZone: "Europe/Zurich",
      updatedAt: "2026-10-29T09:00:00.000Z",
      current: {
        temperatureC: 11.4,
        weatherCode: null,
        isDay: null,
        apparentTemperatureC: null,
        // A percentage stays one.
        relativeHumidity: 100,
        dewPointC: null,
        windSpeedKmh: null,
        windGustsKmh: null,
        windDirection: null,
        uvIndex: null,
      },
      days: [
        {
          date: "2026-10-29",
          temperatureMaxC: null,
          temperatureMinC: 6.1,
          precipitationProbabilityMax: null,
          weatherCode: null,
          precipitationSumMm: null,
          snowfallSumCm: null,
          uvIndexMax: null,
        },
      ],
      // Without the offset, the hour is read in the home's time zone.
      hours: [
        {
          time: "2026-10-29T09:00:00.000Z",
          temperatureC: null,
          weatherCode: null,
          isDay: null,
          precipitationProbability: null,
          precipitationMm: null,
          snowfallCm: null,
        },
      ],
    });
    expect(forecastType.state.parse(forecast)).toEqual(forecast);
  });

  it("has no hours and no weather now when Open-Meteo answers with days alone", async () => {
    const { ctx, state } = fakeCore(app);
    state.internet = async () =>
      answer({
        daily: {
          time: ["2026-10-29"],
          temperature_2m_max: [14.2],
          temperature_2m_min: [6.1],
          precipitation_probability_max: [10],
        },
      });

    const forecast = await fetchForecast(ctx.net, zurich, now);

    expect(forecast.current).toBeNull();
    expect(forecast).not.toHaveProperty("hours");
  });

  it("counts the hours one after another across a change of the clocks", async () => {
    const { ctx, state } = fakeCore(app);
    // The night Zurich's clocks go back: 02:00 comes twice.
    state.internet = async () =>
      answer({
        ...openMeteoAnswer,
        utc_offset_seconds: 7200,
        hourly: {
          time: [
            "2026-10-25T01:00",
            "2026-10-25T02:00",
            "2026-10-25T02:00",
            "2026-10-25T03:00",
          ],
        },
      });

    const forecast = await fetchForecast(
      ctx.net,
      zurich,
      new Date("2026-10-24T23:10:00Z"),
    );

    expect(forecast.hours?.map((hour) => hour.time)).toEqual([
      "2026-10-24T23:00:00.000Z",
      "2026-10-25T00:00:00.000Z",
      "2026-10-25T01:00:00.000Z",
      "2026-10-25T02:00:00.000Z",
    ]);
  });

  it("keeps no more than two days of hours", async () => {
    const { ctx, state } = fakeCore(app);
    state.internet = async () =>
      answer({
        ...openMeteoAnswer,
        hourly: {
          time: Array.from(
            { length: 60 },
            (_, hour) =>
              `2026-10-${29 + Math.floor(hour / 24)}T${String(hour % 24).padStart(2, "0")}:00`,
          ),
        },
      });

    const forecast = await fetchForecast(ctx.net, zurich, now);

    expect(forecast.hours).toHaveLength(48);
    expect(forecastType.state.parse(forecast)).toEqual(forecast);
  });

  it("fails when Open-Meteo answers with anything but a forecast", async () => {
    const { ctx, state } = fakeCore(app);

    state.internet = async () => answer({ error: true }, 503);
    await expect(fetchForecast(ctx.net, zurich, now)).rejects.toThrow(
      "Open-Meteo answered 503",
    );
    state.internet = async () => answer({ daily: { time: "soon" } });
    await expect(fetchForecast(ctx.net, zurich, now)).rejects.toThrow();
    state.internet = async () =>
      answer({ ...openMeteoAnswer, hourly: { time: ["ten o'clock"] } });
    await expect(fetchForecast(ctx.net, zurich, now)).rejects.toThrow();
  });
});

describe("the forecast's type", () => {
  // What an app keeps may have been fetched by an earlier version of it.
  it("takes a forecast with the days and the weather now alone", () => {
    const kept: Forecast = {
      timeZone: "Europe/Zurich",
      updatedAt: "2026-10-29T09:00:00.000Z",
      current: { temperatureC: 11.4, weatherCode: 2, isDay: true },
      days: [
        {
          date: "2026-10-29",
          temperatureMaxC: 14.2,
          temperatureMinC: 6.1,
          precipitationProbabilityMax: 10,
          weatherCode: 2,
        },
      ],
    };

    expect(forecastType.state.parse(kept)).toEqual(kept);
  });
});
