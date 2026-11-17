import type { Forecast } from "@meetsanctum/app-sdk";

import { condition, isWet } from "./conditions.js";
import { hoursLeftToday, weatherNow } from "./hours.js";

// The rest of the home's day in one sentence, from its hours: whether
// something falls now and until when, or from when, and otherwise what the
// sky mostly does. It follows the forecast's own weather codes, as the
// page's icons do, and says nothing where the forecast has no hours left
// today.

export type DaySummary =
  /** It falls now, until an hour of today. */
  | { kind: "wet-until"; words: string; until: string }
  /** It falls now and through the hours left. */
  | { kind: "wet"; words: string }
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
  // The hour it is has the weather now, as the page says it.
  const codes = hours.map((hour, index) =>
    index === 0 ? weatherNow(forecast, now).weatherCode : hour.weatherCode,
  );
  const first = codes[0] ?? null;
  if (first === null) return null;
  const words = (code: number | null) => condition(code).text;

  if (isWet(first)) {
    const dry = codes.findIndex((code) => !isWet(code));
    return dry === -1
      ? { kind: "wet", words: words(first) }
      : { kind: "wet-until", words: words(first), until: hours[dry]!.time };
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
  if (summary.kind === "wet-until") {
    return `${summary.words} until ${time(summary.until)}, then dry.`;
  }
  if (summary.kind === "wet") {
    return `${summary.words} for the rest of the day.`;
  }
  if (summary.kind === "dry-until") {
    return `Dry until ${time(summary.until)}, then ${summary.words.toLowerCase()}.`;
  }
  return `${summary.words} and dry for the rest of the day.`;
}
