import {
  widgetContent,
  type Forecast,
  type SunTimes,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { cardOf, weatherCard } from "../src/card.js";

// What Weather's card says, which the shell draws: the weather now, today's
// high, low and chance of rain, sunrise and sunset, and the next five days,
// all from the home's today.

const now = new Date("2026-10-29T09:00:00Z");

const sun: SunTimes = {
  date: "2026-10-29",
  timeZone: "Europe/Zurich",
  days: [
    {
      date: "2026-10-28",
      sunrise: "2026-10-28T06:04:00.000Z",
      sunset: "2026-10-28T16:17:40.000Z",
      solarNoon: "2026-10-28T11:10:50.000Z",
    },
    {
      date: "2026-10-29",
      sunrise: "2026-10-29T06:05:30.452Z",
      sunset: "2026-10-29T16:16:02.464Z",
      solarNoon: "2026-10-29T11:10:46.458Z",
    },
  ],
};
const day = (date: string, max: number, min: number, code: number) => ({
  date,
  temperatureMaxC: max,
  temperatureMinC: min,
  precipitationProbabilityMax: 20,
  weatherCode: code,
});
const forecast: Forecast = {
  timeZone: "Europe/Zurich",
  updatedAt: "2026-10-29T08:58:00.000Z",
  current: { temperatureC: 11.4, weatherCode: 2, isDay: true },
  days: [
    day("2026-10-28", 13, 5, 3),
    day("2026-10-29", 14.2, 6.1, 2),
    day("2026-10-30", 12.8, 7.4, 61),
    day("2026-10-31", 11, 4, 3),
  ],
};

describe("Weather's card", () => {
  it("shows the weather now, today and the days after", () => {
    const card = cardOf(sun, forecast, now);

    expect(widgetContent.parse(card)).toEqual(card);
    expect(card.blocks).toEqual([
      { kind: "headline", icon: "cloud-sun", value: { temperature: 11.4 } },
      {
        kind: "line",
        text: "Partly cloudy · H {high} L {low} · {rain} rain",
        values: {
          high: { temperature: 14.2 },
          low: { temperature: 6.1 },
          rain: { percent: 20 },
        },
      },
      {
        kind: "facts",
        items: [
          {
            icon: "sunrise",
            label: "Sunrise",
            value: { time: "2026-10-29T06:05:30.452Z" },
          },
          {
            icon: "sunset",
            label: "Sunset",
            value: { time: "2026-10-29T16:16:02.464Z" },
          },
        ],
      },
      {
        kind: "columns",
        items: [
          {
            label: { date: "2026-10-30" },
            icon: "cloud-rain",
            iconLabel: "Light rain",
            value: { temperature: 12.8 },
            detail: { temperature: 7.4 },
          },
          {
            label: { date: "2026-10-31" },
            icon: "cloud",
            iconLabel: "Overcast",
            value: { temperature: 11 },
            detail: { temperature: 4 },
          },
        ],
      },
    ]);
  });

  it("shows the sun while the forecast has not come yet", () => {
    expect(cardOf(sun, null, now).blocks).toEqual([
      { kind: "note", text: "No forecast yet." },
      expect.objectContaining({ kind: "facts" }),
    ]);
  });

  it("moves on to the next day at the home's midnight", () => {
    // 00:30 in Zurich on the 31st: its sun is a day behind, so it has none.
    const card = cardOf(sun, forecast, new Date("2026-10-30T23:30:00Z"));

    expect(card.blocks).toEqual([
      expect.objectContaining({ kind: "headline" }),
      expect.objectContaining({
        kind: "line",
        values: expect.objectContaining({ high: { temperature: 11 } }),
      }),
    ]);
  });

  it("shows the night, a day without its high, and a sun that neither rises nor sets", () => {
    const card = cardOf(
      {
        ...sun,
        days: [{ ...sun.days[1]!, sunrise: null, sunset: null }],
      },
      {
        ...forecast,
        current: { temperatureC: null, weatherCode: 0, isDay: false },
        days: [
          {
            ...day("2026-10-29", 14.2, 6.1, 0),
            temperatureMaxC: null,
            precipitationProbabilityMax: null,
          },
        ],
      },
      now,
    );

    expect(card.blocks).toEqual([
      { kind: "headline", icon: "moon", value: "–" },
      {
        kind: "line",
        text: "Clear · H {high} L {low}",
        values: { high: "–", low: { temperature: 6.1 } },
      },
      { kind: "note", text: "The sun neither rises nor sets today." },
    ]);
  });

  it("says only the weather when the forecast has no today", () => {
    const card = cardOf(null, { ...forecast, days: [] }, now);

    expect(card.blocks).toEqual([
      { kind: "headline", icon: "cloud-sun", value: { temperature: 11.4 } },
      { kind: "line", text: "Partly cloudy", values: {} },
    ]);
  });

  it("previews a card as the home would see one", () => {
    expect(widgetContent.parse(weatherCard.preview)).toEqual(
      weatherCard.preview,
    );
    expect(weatherCard.size).toEqual({ columns: 4, rows: 4 });
  });
});
