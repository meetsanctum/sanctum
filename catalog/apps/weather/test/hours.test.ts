import { describe, expect, it } from "vitest";

import {
  hourColumns,
  hoursFromNow,
  hoursLeftToday,
  plotOf,
  weatherNow,
} from "../src/hours.js";
import { forecast, morning } from "./sample.js";

// The forecast hour by hour, as Weather's page shows it.

const hour = 3_600_000;
const later = (hours: number) => new Date(morning.getTime() + hours * hour);

describe("the hours from now", () => {
  it("start with the hour it is, leaving out those gone by", () => {
    expect(hoursFromNow(forecast, morning)[0]?.time).toBe(
      "2026-10-29T09:00:00.000Z",
    );
    expect(hoursFromNow(forecast, later(0.99))[0]?.time).toBe(
      "2026-10-29T09:00:00.000Z",
    );
    expect(hoursFromNow(forecast, later(1))[0]?.time).toBe(
      "2026-10-29T10:00:00.000Z",
    );
  });

  it("run out once a kept forecast is two days old", () => {
    expect(hoursFromNow(forecast, later(45))).toHaveLength(1);
    expect(hoursFromNow(forecast, later(46))).toEqual([]);
    expect(hoursFromNow({ ...forecast, hours: undefined }, morning)).toEqual(
      [],
    );
  });

  it("end at the home's midnight for today", () => {
    // From ten in the morning in Zurich to the hour before midnight there.
    const left = hoursLeftToday(forecast, morning);
    expect(left).toHaveLength(14);
    expect(left.at(-1)?.time).toBe("2026-10-29T22:00:00.000Z");
  });
});

describe("the weather now", () => {
  it("is what was fetched, while that is recent", () => {
    expect(weatherNow(forecast, later(1.9))).toEqual({
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
    });
  });

  it("is what a forecast kept longer says of the hour it is", () => {
    // Half past three in the night in Zurich.
    const now = weatherNow(forecast, later(17.5));

    expect(now.temperatureC).toBeCloseTo(4.14, 1);
    expect(now).toMatchObject({
      weatherCode: 0,
      isDay: false,
      apparentTemperatureC: null,
      relativeHumidity: null,
      dewPointC: null,
      windSpeedKmh: null,
      windGustsKmh: null,
      windDirection: null,
      uvIndex: null,
    });
  });

  it("stays what was fetched where the forecast has no hour for now", () => {
    const kept = {
      ...forecast,
      hours: undefined,
      current: { temperatureC: 11.4, weatherCode: 2, isDay: true },
    };

    expect(weatherNow(kept, later(30))).toMatchObject({
      temperatureC: 11.4,
      weatherCode: 2,
      isDay: true,
      windSpeedKmh: null,
    });
  });

  it.each([undefined, forecast.hours])(
    "does not restore old measures when the hourly forecast is absent or exhausted (%#)",
    (hours) => {
      expect(weatherNow({ ...forecast, hours }, later(48))).toEqual({
        temperatureC: 11.4,
        weatherCode: 63,
        isDay: true,
        apparentTemperatureC: null,
        relativeHumidity: null,
        dewPointC: null,
        windSpeedKmh: null,
        windGustsKmh: null,
        windDirection: null,
        uvIndex: null,
      });
    },
  );

  it("is unknown without either", () => {
    const empty = { ...forecast, hours: [], current: null };

    expect(Object.values(weatherNow(empty, morning))).toEqual(
      Array.from({ length: 10 }, () => null),
    );
  });
});

describe("the next hours' columns", () => {
  it("are twelve, two hours apart, the first the weather now", () => {
    const columns = hourColumns(forecast, { count: 12, every: 2 }, morning);

    expect(columns.map((column) => column.time.slice(8, 16))).toEqual([
      "29T09:00",
      "29T11:00",
      "29T13:00",
      "29T15:00",
      "29T17:00",
      "29T19:00",
      "29T21:00",
      "29T23:00",
      "30T01:00",
      "30T03:00",
      "30T05:00",
      "30T07:00",
    ]);
    expect(columns[0]).toMatchObject({
      isNow: true,
      startsDay: false,
      temperatureC: 11.4,
      weatherCode: 63,
      precipitationProbability: 80,
    });
    expect(columns.filter((column) => column.isNow)).toHaveLength(1);
  });

  it("mark the first of the home's next day", () => {
    // Midnight in Zurich is 23:00 UTC.
    const starts = (every: number, count: number) =>
      hourColumns(forecast, { count, every }, morning)
        .filter((column) => column.startsDay)
        .map((column) => column.time);

    expect(starts(2, 12)).toEqual(["2026-10-29T23:00:00.000Z"]);
    // Three hours apart, none falls on midnight: the first after it.
    expect(starts(3, 8)).toEqual(["2026-10-30T00:00:00.000Z"]);
  });

  it("are as many as a kept forecast still has", () => {
    const columns = hourColumns(forecast, { count: 12, every: 2 }, later(41));

    expect(columns.map((column) => column.time.slice(8, 16))).toEqual([
      "31T02:00",
      "31T04:00",
      "31T06:00",
    ]);
    // Kept that long, the hour it is says the weather now.
    expect(columns[0]?.weatherCode).toBe(0);
  });
});

describe("the line through the columns' temperatures", () => {
  const size = { column: 50, height: 36, inset: 6 };

  it("puts the warmest near the top and the coldest near the foot, mid column", () => {
    expect(plotOf([8, 11, 5, 8], size)).toEqual({
      points: "25,18 75,6 125,30 175,18",
      first: { x: 25, y: 18 },
    });
  });

  it("leaves out a column without a temperature", () => {
    expect(plotOf([null, 11, null, 5], size)).toEqual({
      points: "75,6 175,30",
      first: null,
    });
  });

  it("runs along the middle when they are all the same, or there is one", () => {
    expect(plotOf([7, 7, 7], size).points).toBe("25,18 75,18 125,18");
    expect(plotOf([7], size).points).toBe("25,18");
    expect(plotOf([], size)).toEqual({ points: "", first: null });
  });
});
