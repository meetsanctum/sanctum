import { afterEach, describe, expect, it } from "vitest";

import { sixHours } from "../src/day-line";
import { timeText } from "../src/device-history-data";
import {
  memoryChart,
  memorySummary,
  nextDayInMs,
  processorSummary,
  readingDay,
  temperatureChart,
  temperatureSummary,
  type HostPoint,
} from "../src/system-status-day";

// Status' last 24 hours (system-status-day.ts): each 5 minutes the manager
// keeps as a line, broken where nothing was read, and what the day came to
// in words, which the chart only illustrates.

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
  it("says the mean and when it was highest, the chart only illustrating it", () => {
    const points = day((at) =>
      at === update
        ? { usage: 0.62, celsius: 67, memoryUsed: 1.2 * 1024 ** 3 }
        : {},
    );
    const usage = readingDay(points, "usage", now);
    expect(usage.line.runs).toHaveLength(1);
    // At the middle of its 5 minutes, where the chart draws it.
    const middle = update + 2.5 * minute;
    expect(usage.highest).toEqual({ value: 0.62, at: middle });
    expect(usage.since).toBeNull();
    expect(processorSummary(usage)).toBe(
      `4% on average · busiest at ${timeText(middle)}, 62%`,
    );
    expect(
      temperatureSummary(readingDay(points, "celsius", now, 80), "celsius"),
    ).toBe(`56°C on average · warmest at ${timeText(middle)}, 67°C`);
    expect(memorySummary(readingDay(points, "memoryUsed", now))).toBe(
      `652 MB on average · most at ${timeText(middle)}, 1.2 GB`,
    );
  });

  it("breaks the line where nothing was read, and says so", () => {
    const from = Date.parse("2026-11-02T02:10:00Z");
    const to = Date.parse("2026-11-02T02:40:00Z");
    const points = day(() => ({})).filter(
      (point) => Date.parse(point.at) < from || Date.parse(point.at) >= to,
    );
    const usage = readingDay(points, "usage", now);
    expect(usage.line.runs).toHaveLength(2);
    expect(usage.gap).toEqual({ from, to });
    expect(processorSummary(usage)).toContain(
      `no readings from ${timeText(from)} to ${timeText(to)}`,
    );
  });

  it("starts where its readings do, on a day not yet full", () => {
    const since = Date.parse("2026-11-02T14:20:00Z");
    const celsius = readingDay(
      day(() => ({}), since),
      "celsius",
      now,
      80,
    );
    expect(celsius.since).toBe(since);
    expect(temperatureSummary(celsius, "celsius")).toMatch(
      new RegExp(`^56°C on average since ${timeText(since)} · warmest`),
    );
  });

  it("reports missing completed periods through the present", () => {
    const from = now - 60 * minute;
    const points = day((at) => (at >= from ? { celsius: null } : {}));
    const celsius = readingDay(points, "celsius", now + minute, 80);
    expect(celsius.gap).toEqual({ from, to: now });
    expect(temperatureSummary(celsius, "celsius")).toContain(
      `no readings from ${timeText(from)} to ${timeText(now)}`,
    );
    expect(
      readingDay(
        day(() => ({})),
        "celsius",
        now + minute,
      ).gap,
    ).toBeNull();
    // Just after 5 minutes end, before the manager's next sample keeps them.
    expect(
      readingDay(
        day(() => ({})),
        "celsius",
        now + 5 * minute + 5_000,
      ).gap,
    ).toBeNull();
  });

  it("says when it was too hot, in the home's unit", () => {
    const hot = (at: number) =>
      at >= Date.parse("2026-11-02T15:10:00Z") &&
      at < Date.parse("2026-11-02T16:00:00Z");
    const celsius = readingDay(
      day((at) => (hot(at) ? { celsius: 84 } : {})),
      "celsius",
      now,
      80,
    );
    expect(celsius.over).toEqual({
      from: Date.parse("2026-11-02T15:10:00Z"),
      to: Date.parse("2026-11-02T16:00:00Z"),
    });
    expect(temperatureSummary(celsius, "fahrenheit")).toBe(
      `Too hot from ${timeText(celsius.over!.from)} to ${timeText(celsius.over!.to)} · warmest at ${timeText(celsius.highest!.at)}, 183°F`,
    );
  });

  it("carries the line on to now with what Status read last, the words keeping to the 5 minutes kept", () => {
    const points = day((at) => (at === update ? { usage: 0.62 } : {}));
    const usage = readingDay(points, "usage", now, undefined, 0.9);
    expect(usage.line.runs).toHaveLength(1);
    expect(usage.line.runs[0]!.at(-1)).toEqual({ at: now, value: 0.9 });
    expect(usage.line.max).toBe(0.9);
    expect(processorSummary(usage)).toBe(
      processorSummary(readingDay(points, "usage", now)),
    );
  });

  it("lets what Status read stand on its own after a stretch without readings", () => {
    const from = now - 30 * minute;
    const points = day(() => ({})).filter(
      (point) => Date.parse(point.at) < from,
    );
    const celsius = readingDay(points, "celsius", now, 80, 61);
    expect(celsius.line.runs).toHaveLength(2);
    expect(celsius.line.runs[1]).toEqual([{ at: now, value: 61 }]);
    expect(celsius.gap?.from).toBe(from);
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

  it("says nothing was read before the first 5 minutes end", () => {
    expect(processorSummary(readingDay([], "usage", now))).toBe(
      "Nothing read yet",
    );
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

describe("the hours under a day", () => {
  const zone = process.env.TZ;
  afterEach(() => {
    process.env.TZ = zone;
  });

  it("stay on the clock's 6 hours on the day the clocks go back", () => {
    process.env.TZ = "Europe/Berlin";
    // Summer time ended at 03:00 on 25 October 2026.
    const to = Date.parse("2026-10-25T20:00:00+01:00");
    expect(
      sixHours(to - 24 * 60 * minute, to).map((at) => timeText(at)),
    ).toEqual(["00:00", "06:00", "12:00", "18:00"]);
  });
});
