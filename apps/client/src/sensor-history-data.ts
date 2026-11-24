import type { DeviceStatistics, HistoryStatistic } from "@meetsanctum/app-sdk";

import { dayMs, midnight } from "./device-history-data";

// What a sensor's detail charts, from core History's roll-ups: the last 24
// hours as a line through each 5 minutes' mean, broken where nothing was
// known, and the last 7 days as each day's lowest and highest, from the
// hourly roll-ups. What it reads now carries each to now, since the last 5
// minutes or hour have not been rolled up yet. Values are in the measure's
// standard unit; the page converts temperatures as it draws.

const fiveMinutes = 5 * 60_000;

/** One reading on the day's line: a 5 minutes' mean at its middle, or what it reads now. */
export type Point = { at: number; value: number };

/** The last 24 hours: the line in its runs, and the lowest and highest it read. */
export type DayLine = {
  runs: Point[][];
  min: number | null;
  max: number | null;
};

const statisticsOf = (statistics: Pick<DeviceStatistics, "fields"> | null) =>
  statistics?.fields.value ?? [];

/**
 * The line from the 5-minute roll-ups since `now` less a day, and what it
 * reads now, if anything: a run ends where a 5 minutes went unknown, as
 * while the sensor was offline.
 */
export function dayLine(
  statistics: Pick<DeviceStatistics, "fields" | "to"> | null,
  now: number,
  current: number | null,
): DayLine {
  const from = now - dayMs;
  const periods = statisticsOf(statistics).filter(
    (each) => Date.parse(each.start) + fiveMinutes > from,
  );
  const runs: Point[][] = [];
  let run: Point[] = [];
  let last: number | null = null;
  for (const period of periods) {
    const start = Date.parse(period.start);
    if (last !== null && start - last > fiveMinutes) {
      runs.push(run);
      run = [];
    }
    run.push({
      at: Math.max(from, start + fiveMinutes / 2),
      value: period.mean,
    });
    last = start;
  }
  if (current !== null) {
    // What it reads now joins the line when the last 5 minutes it was
    // known were the latest ended; otherwise it starts a run of its own.
    // Only a completed period covered by the snapshot can be missing.
    // Between refreshes, later periods have not been requested yet.
    const through = statistics ? Math.min(now, Date.parse(statistics.to)) : now;
    const currentPeriod = Math.floor(through / fiveMinutes) * fiveMinutes;
    if (last !== null && last + fiveMinutes < currentPeriod) {
      runs.push(run);
      run = [];
    }
    run.push({ at: now, value: current });
  }
  if (run.length > 0) runs.push(run);
  const values = [
    ...periods.flatMap((each) => [each.min, each.max]),
    ...(current === null ? [] : [current]),
  ];
  return {
    runs,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
}

/** One day of the week: its lowest and highest, or none when nothing was known. */
export type DayRange = {
  start: number;
  min: number | null;
  max: number | null;
};

/** The last 7 local days, today last, from the hourly roll-ups and what it reads now. */
export function weekRanges(
  statistics: Pick<DeviceStatistics, "fields"> | null,
  now: number,
  current: number | null,
): DayRange[] {
  const hours: HistoryStatistic[] = statisticsOf(statistics);
  const days: DayRange[] = [];
  for (let back = 6; back >= 0; back--) {
    const start = midnight(now, back);
    const end = midnight(now, back - 1);
    // An hour that local midnight splits counts on the day it starts.
    const own = hours.filter((hour) => {
      const at = Date.parse(hour.start);
      return at >= start && at < end;
    });
    const values = own.flatMap((hour) => [hour.min, hour.max]);
    if (back === 0 && current !== null) values.push(current);
    days.push({
      start,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
    });
  }
  return days;
}

/** The lowest and highest of the week, over the days that were known. */
export function weekRange(days: readonly DayRange[]) {
  const known = days.filter((day) => day.min !== null && day.max !== null);
  return known.length
    ? {
        min: Math.min(...known.map((day) => day.min!)),
        max: Math.max(...known.map((day) => day.max!)),
      }
    : null;
}
