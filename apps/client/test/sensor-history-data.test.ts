import type { HistoryStatistic } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { dayMs, midnight } from "../src/device-history-data";
import { dayLine, weekRange, weekRanges } from "../src/sensor-history-data";

// What a sensor's detail charts (sensor-history-data.ts): its day as a line
// through each 5 minutes, broken where nothing was known, and its week as
// each day's lowest and highest.

const minute = 60_000;
const now = Date.parse("2026-10-31T12:00:00.000Z");

const period = (
  start: number,
  mean: number,
  min = mean,
  max = mean,
): HistoryStatistic => ({
  start: new Date(start).toISOString(),
  mean,
  min,
  max,
  seconds: 300,
});
const fields = (value: HistoryStatistic[]) => ({
  fields: { value },
  to: new Date(now).toISOString(),
});

describe("a sensor's day", () => {
  it("is a line through each 5 minutes' mean, to what it reads now", () => {
    const line = dayLine(
      fields([
        period(now - 10 * minute, 21, 20.8, 21.1),
        period(now - 5 * minute, 21.4, 21.2, 21.5),
      ]),
      now,
      21.6,
    );

    expect(line.runs).toEqual([
      [
        { at: now - 7.5 * minute, value: 21 },
        { at: now - 2.5 * minute, value: 21.4 },
        { at: now, value: 21.6 },
      ],
    ]);
    expect([line.min, line.max]).toEqual([20.8, 21.6]);
  });

  it("does not join a live reading across a missing final period", () => {
    expect(
      dayLine(fields([period(now - 10 * minute, 21)]), now, 22).runs,
    ).toEqual([
      [{ at: now - 7.5 * minute, value: 21 }],
      [{ at: now, value: 22 }],
    ]);
  });

  it("joins the latest completed period throughout the current five minutes", () => {
    const later = now + 4 * minute;
    expect(
      dayLine(fields([period(now - 5 * minute, 21)]), later, 22).runs,
    ).toEqual([
      [
        { at: now - 2.5 * minute, value: 21 },
        { at: later, value: 22 },
      ],
    ]);
  });

  it("does not invent gaps for periods not yet requested between refreshes", () => {
    const later = now + 6 * minute;
    const snapshot = {
      ...fields([period(now - 5 * minute, 21)]),
      to: new Date(now + 2 * minute).toISOString(),
    };
    expect(dayLine(snapshot, later, 22).runs).toEqual([
      [
        { at: now - 2.5 * minute, value: 21 },
        { at: later, value: 22 },
      ],
    ]);
  });

  it("breaks where nothing was known, as while the sensor was offline", () => {
    const line = dayLine(
      fields([
        period(now - 60 * minute, 20),
        period(now - 55 * minute, 20.2),
        period(now - 20 * minute, 21),
      ]),
      now,
      null,
    );

    expect(line.runs.map((run) => run.map((each) => each.value))).toEqual([
      [20, 20.2],
      [21],
    ]);
  });

  it("leaves out what is older than a day, and is empty before anything is known", () => {
    const line = dayLine(
      fields([period(now - dayMs - 10 * minute, 30), period(now - minute, 22)]),
      now,
      null,
    );
    expect(line.runs.flat().map((each) => each.value)).toEqual([22]);
    expect(dayLine(null, now, null)).toEqual({
      runs: [],
      min: null,
      max: null,
    });
  });
});

describe("a sensor's week", () => {
  it("is each local day's lowest and highest, today with what it reads now", () => {
    const today = midnight(now);
    const yesterday = midnight(now, 1);
    const days = weekRanges(
      fields([
        period(yesterday + 60 * minute, 20, 18.9, 21),
        period(yesterday + 120 * minute, 22, 21, 23.1),
        period(today + 60 * minute, 21, 20.5, 21.5),
      ]),
      now,
      22,
    );

    expect(days).toHaveLength(7);
    expect(days.at(-1)).toEqual({ start: today, min: 20.5, max: 22 });
    expect(days.at(-2)).toEqual({ start: yesterday, min: 18.9, max: 23.1 });
    expect(days[0]).toEqual({ start: midnight(now, 6), min: null, max: null });
    expect(weekRange(days)).toEqual({ min: 18.9, max: 23.1 });
    expect(weekRange(weekRanges(null, now, null))).toBeNull();
  });
});
