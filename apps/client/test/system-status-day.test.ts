import { describe, expect, it } from "vitest";

import {
  memoryChart,
  nextDayInMs,
  readingDay,
  temperatureChart,
  type HostPoint,
} from "../src/system-status-day";

// Status' last 24 hours (system-status-day.ts): each 5 minutes the manager
// keeps as a line, broken where nothing was read.

const minute = 60_000;
const now = Date.parse("2026-11-02T21:45:00Z");

// A quiet day with the update at 18:10, local time.
function day(
  value: (at: number) => Partial<Omit<HostPoint, "at">>,
  from = now - 24 * 60 * minute,
) {
  const points: HostPoint[] = [];
  const first = Math.ceil(from / (5 * minute)) * 5 * minute;
  for (let at = first; at + 5 * minute <= now; at += 5 * minute) {
    points.push({
      at: new Date(at).toISOString(),
      usage: 0.04,
      celsius: 56,
      memoryUsed: 650 * 1024 ** 2,
      ...value(at),
    });
  }
  return points;
}

const update = Date.parse("2026-11-02T18:10:00Z");

describe("the host's day", () => {
  it("draws each 5 minutes at its middle", () => {
    const points = day((at) => (at === update ? { usage: 0.62 } : {}));
    const usage = readingDay(points, "usage", now);
    expect(usage.runs).toHaveLength(1);
    expect(usage.runs[0]).toContainEqual({
      at: update + 2.5 * minute,
      value: 0.62,
    });
    expect(usage.max).toBe(0.62);
    expect(usage.min).toBe(0.04);
  });

  it("breaks the line where nothing was read", () => {
    const from = Date.parse("2026-11-02T02:10:00Z");
    const to = Date.parse("2026-11-02T02:40:00Z");
    const points = day(() => ({})).filter(
      (point) => Date.parse(point.at) < from || Date.parse(point.at) >= to,
    );
    const usage = readingDay(points, "usage", now);
    expect(usage.runs).toHaveLength(2);
    expect(usage.runs[0]!.at(-1)!.at).toBe(from - 2.5 * minute);
    expect(usage.runs[1]![0]!.at).toBe(to + 2.5 * minute);
  });

  it("starts where its readings do, on a day not yet full", () => {
    const since = Date.parse("2026-11-02T14:20:00Z");
    const celsius = readingDay(
      day(() => ({}), since),
      "celsius",
      now,
    );
    expect(celsius.runs[0]![0]!.at).toBe(since + 2.5 * minute);
  });

  it("counts missing completed periods through the present", () => {
    const from = now - 60 * minute;
    const points = day((at) => (at >= from ? { celsius: null } : {}));
    expect(readingDay(points, "celsius", now + minute, 61).runs).toHaveLength(
      2,
    );
    expect(
      readingDay(
        day(() => ({})),
        "celsius",
        now + minute,
        61,
      ).runs,
    ).toHaveLength(1);
    // Just after 5 minutes end, before the manager's next sample keeps them.
    expect(
      readingDay(
        day(() => ({})),
        "celsius",
        now + 5 * minute + 5_000,
        61,
      ).runs,
    ).toHaveLength(1);
  });

  it("carries the line on to now with what Status read last", () => {
    const points = day((at) => (at === update ? { usage: 0.62 } : {}));
    const usage = readingDay(points, "usage", now, 0.9);
    expect(usage.runs).toHaveLength(1);
    expect(usage.runs[0]!.at(-1)).toEqual({ at: now, value: 0.9 });
    expect(usage.max).toBe(0.9);
  });

  it("lets what Status read stand on its own after a stretch without readings", () => {
    const from = now - 30 * minute;
    const points = day(() => ({})).filter(
      (point) => Date.parse(point.at) < from,
    );
    const celsius = readingDay(points, "celsius", now, 61);
    expect(celsius.runs).toHaveLength(2);
    expect(celsius.runs[1]).toEqual([{ at: now, value: 61 }]);
  });

  it("has nothing to draw before the first 5 minutes end", () => {
    expect(readingDay([], "usage", now)).toEqual({
      runs: [],
      min: null,
      max: null,
    });
  });

  it("asks for the day again just after the 5 minutes under way end", () => {
    const at = Date.parse("2026-11-02T22:31:20Z");
    expect(nextDayInMs(at)).toBe(3 * minute + 40_000 + 15_000);
  });

  it.each([
    ["22:30:00", 15_000],
    ["22:30:05", 10_000],
    ["22:30:14.999", 1],
    ["22:30:15", 5 * minute],
    ["22:30:16", 5 * minute - 1_000],
  ])("schedules the next refresh from %s", (time, delay) => {
    expect(nextDayInMs(Date.parse(`2026-11-02T${time}Z`))).toBe(delay);
  });

  it("keeps fixed ranges where the bounds mean something", () => {
    expect(temperatureChart("celsius").scale).toEqual({
      min: 20,
      max: 90,
      lines: [20, 50, 80],
    });
    const fahrenheit = temperatureChart("fahrenheit");
    expect(fahrenheit.above).toBe(176);
    expect(fahrenheit.scale.lines.map(fahrenheit.format.grid)).toEqual([
      "68°F",
      "122°F",
      "176°F",
    ]);
    const memory = memoryChart(7.64 * 1024 ** 3);
    expect(memory.scale.lines.map(memory.format.grid)).toEqual([
      "0",
      "4 GB",
      "7.64 GB",
    ]);
  });
});
