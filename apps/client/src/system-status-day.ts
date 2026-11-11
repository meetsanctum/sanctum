import type { TemperatureUnit } from "@meetsanctum/app-sdk";
import { convertTemperature, formatTemperature } from "@meetsanctum/ui-sdk";
import { useEffect, useRef, useState } from "react";

import { coreJson } from "./core-fetch";
import type { ChartFormat } from "./day-line";
import { dayMs, timeText } from "./device-history-data";
import type { DayLine, Point } from "./sensor-history-data";
import {
  formatMemory,
  hotCelsius,
  temperatureWord,
  type HostInfo,
} from "./system-status";

// Settings → Status' last 24 hours: how busy the processor was, how warm it
// ran and how much memory was in use, each 5 minutes' mean as the manager
// keeps them, carried on to now by what Status reads every 5 seconds, as a
// sensor's day is by what it reads now; and what each day came to in words,
// which the chart only illustrates: its mean, its highest and when, since
// when it was read, where nothing was, and when it was too hot. The words
// keep to the 5 minutes kept.

/** Each 5 minutes of the day, as GET /api/system/history answers. */
export type HostPoint = {
  at: string;
  usage: number | null;
  celsius: number | null;
  memoryUsed: number | null;
};

const fiveMinutes = 5 * 60_000;
// The manager keeps an ended 5 minutes at its next 10-second sample.
const closesWithinMs = 60_000;
// The day is asked again this long after each 5 minutes end, once the
// manager has kept them.
const afterEndMs = 15_000;
// How long a look at the day may take.
const lookTimeoutMs = 30_000;

/** How long until the next refresh, including one still due after the last boundary. */
export const nextDayInMs = (now: number) =>
  fiveMinutes - ((now - afterEndMs) % fiveMinutes);

/** The day, asked when the page opens and just after each 5 minutes end, as a new point is kept. */
export function useHostDay(now: number) {
  const [day, setDay] = useState<{ points: HostPoint[]; through: number }>();
  const [failed, setFailed] = useState(false);
  // Keep the snapshot's coverage on the host's clock, like the live point.
  const checkedAt = useRef(now);
  useEffect(() => {
    checkedAt.current = now;
  }, [now]);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      // The next look is due from when this one began, so a slow answer
      // doesn't skip the end of the 5 minutes under way.
      const began = Date.now();
      const through = checkedAt.current;
      try {
        // A look that never answers gives up, so the next one still comes.
        const answer = await coreJson<{ points: HostPoint[] }>(
          "/api/system/history",
          { signal: AbortSignal.timeout(lookTimeoutMs) },
        );
        if (!current) return;
        setDay({ points: answer.points, through });
        setFailed(false);
      } catch {
        if (current) setFailed(true);
      }
      if (current) {
        timer = setTimeout(
          load,
          Math.max(0, nextDayInMs(began) - (Date.now() - began)),
        );
      }
    };
    void load();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, []);
  return { day, failed };
}

/** One reading's day: its line, and what it came to. */
export type ReadingDay = {
  line: DayLine;
  mean: number | null;
  highest: { value: number; at: number } | null;
  // When the readings start, if well after the day did.
  since: number | null;
  // The longest stretch without readings.
  gap: { from: number; to: number } | null;
  // From the first 5 minutes over the threshold to the end of the last.
  over: { from: number; to: number } | null;
};

export function readingDay(
  points: readonly HostPoint[],
  key: "usage" | "celsius" | "memoryUsed",
  now: number,
  threshold?: number,
  // What Status read last, which carries the line to now.
  reading: number | null = null,
  // Only periods covered by a successful history read can be missing.
  through = now,
): ReadingDay {
  const from = now - dayMs;
  const known = points
    .map((point) => ({ start: Date.parse(point.at), value: point[key] }))
    .filter(
      (each): each is { start: number; value: number } =>
        each.value !== null && each.start + fiveMinutes > from,
    );
  const runs: Point[][] = [];
  let run: Point[] = [];
  let gap: ReadingDay["gap"] = null;
  let last: number | null = null;
  for (const { start, value } of known) {
    if (last !== null && start - last > fiveMinutes) {
      runs.push(run);
      run = [];
      if (!gap || start - (last + fiveMinutes) > gap.to - gap.from) {
        gap = { from: last + fiveMinutes, to: start };
      }
    }
    run.push({ at: Math.max(from, start + fiveMinutes / 2), value });
    last = start;
  }
  if (run.length > 0) runs.push(run);
  // A missing reading can continue through the present. Only completed
  // periods count; the current five minutes have not been reported yet,
  // nor the last for the few seconds until the manager's next sample.
  // A later Status reading does not extend an older history snapshot.
  const completedThrough =
    Math.floor((Math.min(now, through) - closesWithinMs) / fiveMinutes) *
    fiveMinutes;
  const missing = last !== null && completedThrough > last + fiveMinutes;
  if (missing) {
    const trailing = { from: last! + fiveMinutes, to: completedThrough };
    if (!gap || trailing.to - trailing.from > gap.to - gap.from) gap = trailing;
  }
  // What was read now joins the line where the 5 minutes before it were
  // kept; after a stretch without them it stands on its own.
  if (reading !== null && Number.isFinite(reading)) {
    const point = { at: now, value: reading };
    const latest = runs.at(-1);
    if (latest && !missing) latest.push(point);
    else runs.push([point]);
  }
  const values = known.map((each) => each.value);
  const top = known.reduce<(typeof known)[number] | null>(
    (best, each) => (!best || each.value > best.value ? each : best),
    null,
  );
  const hot =
    threshold === undefined
      ? []
      : known.filter((each) => each.value >= threshold);
  const first = known[0];
  const drawn = runs.flat().map((point) => point.value);
  return {
    line: {
      runs,
      min: drawn.length ? Math.min(...drawn) : null,
      max: drawn.length ? Math.max(...drawn) : null,
    },
    mean: values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null,
    // When the chart's point is: the middle of its 5 minutes.
    highest: top && { value: top.value, at: top.start + fiveMinutes / 2 },
    since: first && first.start - from > 3 * fiveMinutes ? first.start : null,
    gap,
    over: hot.length
      ? { from: hot[0]!.start, to: hot.at(-1)!.start + fiveMinutes }
      : null,
  };
}

const percent = (usage: number) => `${Math.round(usage * 100)}%`;

// What each reading came to, in a line: "4% on average · busiest at 18:10,
// 62%", with where nothing was read after it.
function summary(
  day: ReadingDay,
  text: (value: number) => string,
  most: string,
  lead?: string,
) {
  if (day.mean === null || !day.highest) return "Nothing read yet";
  const since = day.since === null ? "" : ` since ${timeText(day.since)}`;
  const parts = [
    lead ?? `${text(day.mean)} on average${since}`,
    `${most} at ${timeText(day.highest.at)}, ${text(day.highest.value)}`,
  ];
  if (day.gap) {
    parts.push(
      `no readings from ${timeText(day.gap.from)} to ${timeText(day.gap.to)}`,
    );
  }
  return parts.join(" · ");
}

export const processorSummary = (day: ReadingDay) =>
  summary(day, percent, "busiest");

export function temperatureSummary(day: ReadingDay, unit: TemperatureUnit) {
  const text = (celsius: number) =>
    formatTemperature(celsius, unit, { whole: true });
  return summary(
    day,
    text,
    "warmest",
    day.over
      ? `Too hot from ${timeText(day.over.from)} to ${timeText(day.over.to)}`
      : undefined,
  );
}

export const memorySummary = (day: ReadingDay) =>
  summary(day, formatMemory, "most");

// What each reads now, heading its chart: "3% now", "57°C now · normal",
// "627 MB now".
export const processorNow = (usage: number | null) =>
  usage === null ? null : `${percent(usage)} now`;

export function temperatureNow(celsius: number | null, unit: TemperatureUnit) {
  if (celsius === null) return null;
  const text = formatTemperature(celsius, unit, { whole: true });
  return `${text} now · ${temperatureWord(celsius)}`;
}

export const memoryNow = (memory: HostInfo["memory"]) =>
  memory && `${formatMemory(memory.total - memory.available)} now`;

// How each chart shows its values, on fixed ranges where the bounds mean
// something: all of the processor, the temperatures a Pi runs at, with 80 °C
// where it slows itself down, and all of the memory.
const gutter = 60;

export const processorChart = {
  format: {
    gutter,
    shown: (usage: number) => usage * 100,
    text: percent,
    grid: (shown: number) => `${shown}%`,
  } satisfies ChartFormat,
  scale: { min: 0, max: 100, lines: [0, 50, 100] },
};

export function temperatureChart(unit: TemperatureUnit) {
  const shown = (celsius: number) =>
    Math.round(convertTemperature(celsius, "celsius", unit));
  return {
    format: {
      gutter,
      shown: (celsius: number) => convertTemperature(celsius, "celsius", unit),
      text: (celsius: number) =>
        formatTemperature(celsius, unit, { whole: true }),
      grid: (value: number) =>
        formatTemperature(convertTemperature(value, unit, "celsius"), unit, {
          whole: true,
        }),
    } satisfies ChartFormat,
    scale: {
      min: shown(20),
      max: shown(90),
      lines: [20, 50, hotCelsius].map(shown),
    },
    above: shown(hotCelsius),
  };
}

export function memoryChart(total: number) {
  const gib = 1024 ** 3;
  const all = total / gib;
  const half = Math.round(all / 2);
  return {
    format: {
      gutter,
      shown: (bytes: number) => bytes / gib,
      text: formatMemory,
      grid: (shown: number) =>
        shown === all ? formatMemory(total) : shown === 0 ? "0" : `${shown} GB`,
    } satisfies ChartFormat,
    scale: {
      min: 0,
      max: all,
      lines: [0, ...(half > 0 && half < all ? [half] : []), all],
    },
  };
}
