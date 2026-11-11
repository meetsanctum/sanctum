import { forecastType } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { fetchForecast } from "../src/forecast.js";
import app from "../src/index.js";
import { answer, fakeCore, openMeteoAnswer } from "./fake-core.js";

// The forecast from Open-Meteo, ported from v1's weather.ts and its tests.

const zurich = {
  latitude: 47.3769,
  longitude: 8.5417,
  elevation: 408,
  timeZone: "Europe/Zurich",
};
const now = new Date("2026-10-29T09:00:00Z");

describe("the forecast", () => {
  it("asks Open-Meteo for ten days and the weather now, in the home's time zone", async () => {
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
      current: "temperature_2m,weather_code,is_day",
      daily:
        "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
      temperature_unit: "celsius",
      timezone: "Europe/Zurich",
      forecast_days: "10",
    });
    expect(request!.timeoutMs).toBe(5_000);
    expect(forecast).toEqual({
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
        {
          date: "2026-10-30",
          temperatureMaxC: 12.8,
          temperatureMinC: 7.4,
          precipitationProbabilityMax: 65,
          weatherCode: 61,
        },
      ],
    });
    expect(forecastType.state.parse(forecast)).toEqual(forecast);
  });

  it("keeps what Open-Meteo leaves out as unknown", async () => {
    const { ctx, state } = fakeCore(app);
    state.internet = async () =>
      answer({
        daily: {
          time: ["2026-10-29"],
          temperature_2m_max: [null],
          temperature_2m_min: [6.1],
          precipitation_probability_max: [],
        },
      });

    expect(await fetchForecast(ctx.net, zurich, now)).toMatchObject({
      current: null,
      days: [
        {
          date: "2026-10-29",
          temperatureMaxC: null,
          temperatureMinC: 6.1,
          precipitationProbabilityMax: null,
          weatherCode: null,
        },
      ],
    });
  });

  it("fails when Open-Meteo answers with anything but a forecast", async () => {
    const { ctx, state } = fakeCore(app);

    state.internet = async () => answer({ error: true }, 503);
    await expect(fetchForecast(ctx.net, zurich, now)).rejects.toThrow(
      "Open-Meteo answered 503",
    );
    state.internet = async () => answer({ daily: { time: "soon" } });
    await expect(fetchForecast(ctx.net, zurich, now)).rejects.toThrow();
  });
});
