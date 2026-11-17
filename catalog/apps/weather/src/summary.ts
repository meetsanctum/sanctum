import type { Forecast } from "@meetsanctum/app-sdk";

import { condition, isWet } from "./conditions.js";
import { homeDate } from "./days.js";
import { hoursLeftToday, weatherNow } from "./hours.js";

// The rest of the home's day in one sentence, from its hours: whether
// something falls now and until when, on and off where it pauses on the
// way, or from when, and otherwise what the sky mostly does. It follows the forecast's own weather codes, as the
// page's icons do, and says nothing without known hours through the end of
// today.

const hourMs = 3_600_000;

export type DaySummary =
  /** It falls now, until an hour of today, with dry hours between or none. */
  | { kind: "wet-until"; words: string; until: string; hasBreaks: boolean }
  /** It falls now and to the day's end, with dry hours between or none. */
  | { kind: "wet"; words: string; hasBreaks: boolean }
  /** Nothing falls now, but from an hour of today on it does. */
  | { kind: "dry-until"; until: string; words: string }
  /** Nothing falls in the hours left: the sky they mostly have. */
  | { kind: "dry"; words: string };

export function daySummary(
  forecast: Forecast,
  now = new Date(),
): DaySummary | null {
  const hours = hoursLeftToday(forecast, now);
  if (hours.length === 0) return null;
  // A kept forecast may end partway through today. Its remaining hours
  // cannot say what happens for the rest of the day.
  const today = homeDate(forecast.timeZone, now);
  const end = new Date(Date.parse(hours.at(-1)!.time) + hourMs);
  if (homeDate(forecast.timeZone, end) === today) return null;
  // The hour it is has the weather now, as the page says it.
  const codes = hours.map((hour, index) =>
    index === 0 ? weatherNow(forecast, now).weatherCode : hour.weatherCode,
  );
  const first = codes[0] ?? null;
  if (first === null || codes.includes(null)) return null;
  const words = (code: number | null) => condition(code).text;

  if (isWet(first)) {
    // It is dry only after the last hour something falls: a dry hour before
    // that is a break, which the sentence says as on and off.
    const dry = codes.reduce<number>(
      (end, code, index) => (isWet(code) ? index + 1 : end),
      0,
    );
    const hasBreaks = codes.slice(0, dry).some((code) => !isWet(code));
    return dry === codes.length
      ? { kind: "wet", words: words(first), hasBreaks }
      : {
          kind: "wet-until",
          words: words(first),
          until: hours[dry]!.time,
          hasBreaks,
        };
  }
  const wet = codes.findIndex(isWet);
  if (wet !== -1) {
    return {
      kind: "dry-until",
      until: hours[wet]!.time,
      words: words(codes[wet]!),
    };
  }
  // The sky most of the hours left have; of two as common, the earlier.
  const counts = new Map<string, number>();
  for (const code of codes) {
    if (code === null) continue;
    counts.set(words(code), (counts.get(words(code)) ?? 0) + 1);
  }
  const [most] = [...counts].sort(([, a], [, b]) => b - a);
  return { kind: "dry", words: most![0] };
}

/** The summary as a sentence, with its hour written by `time`, as the device writes times. */
export function summarySentence(
  summary: DaySummary,
  time: (instant: string) => string,
) {
  if (summary.kind === "wet-until" || summary.kind === "wet") {
    const falls = summary.hasBreaks
      ? `${summary.words} on and off`
      : summary.words;
    return summary.kind === "wet"
      ? `${falls} for the rest of the day.`
      : `${falls} until ${time(summary.until)}, then dry.`;
  }
  if (summary.kind === "dry-until") {
    return `Dry until ${time(summary.until)}, then ${summary.words.toLowerCase()}.`;
  }
  return `${summary.words} and dry for the rest of the day.`;
}
