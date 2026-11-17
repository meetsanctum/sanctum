import type { ForecastDay } from "@meetsanctum/app-sdk";

import type { DaySummary } from "./summary.js";

// Today's measures on Weather's page: what falls, the wind, the UV index and
// the humidity, each a number with one short line under it.

/** What falls today: rain in millimetres, or snow in centimetres. */
export type Fall = { kind: "rain" | "snow"; amount: number | null };

// A centimetre of snow is about 1.4 mm of water, as Open-Meteo counts it
// (7 cm to 10 mm).
const waterMmPerSnowCm = 10 / 7;

/**
 * What falls on a day. It is snow when at least half of the day's water
 * falls as snow, and rain otherwise, a day without amounts included.
 */
export function fallOf(day: ForecastDay | undefined): Fall {
  const water = day?.precipitationSumMm ?? null;
  const snow = day?.snowfallSumCm ?? null;
  if (
    snow !== null &&
    snow > 0 &&
    snow * waterMmPerSnowCm >= (water ?? 0) / 2
  ) {
    return { kind: "snow", amount: snow };
  }
  return { kind: "rain", amount: water };
}

/**
 * The line under what falls: until when, or from when, by the day's
 * summary, and whether any has fallen where no more comes. Empty where the
 * forecast has no hours to tell, or no total to say whether any fell.
 */
export function fallLine(
  fall: Fall,
  summary: DaySummary | null,
  time: (instant: string) => string,
) {
  if (!summary) return "";
  if (summary.kind === "wet-until") return `Until ${time(summary.until)}`;
  if (summary.kind === "wet") return "Rest of the day";
  if (summary.kind === "dry-until") return `From ${time(summary.until)}`;
  if (fall.amount === null) return "";
  return fall.amount > 0 ? "No more today" : "None today";
}

const compass = [
  "North",
  "North-east",
  "East",
  "South-east",
  "South",
  "South-west",
  "West",
  "North-west",
] as const;

/** Where the wind comes from, as one of eight directions, such as West for 270°. */
export function windFrom(degrees: number) {
  return compass[Math.round((((degrees % 360) + 360) % 360) / 45) % 8]!;
}

// A direction as a compass writes it: the capital of each of its words,
// such as SW for South-west.
const point = (from: string) =>
  from
    .split("-")
    .map((word) => word.charAt(0).toUpperCase())
    .join("");

/**
 * The line under the wind's speed, with what is known of where it comes
 * from and its gusts. Beside the gusts the direction is a compass point,
 * such as "SW, gusts 22", since a small card has no room for both in words.
 */
export function windLine(wind: {
  windDirection: number | null;
  windGustsKmh: number | null;
}) {
  const from =
    wind.windDirection === null ? null : windFrom(wind.windDirection);
  const gusts =
    wind.windGustsKmh === null ? null : Math.round(wind.windGustsKmh);
  if (from && gusts !== null) return `${point(from)}, gusts ${gusts}`;
  if (from) return from;
  return gusts === null ? "" : `Gusts ${gusts}`;
}

/** The World Health Organization's word for a UV index. */
export function uvLevel(index: number) {
  const whole = Math.round(index);
  if (whole <= 2) return "Low";
  if (whole <= 5) return "Moderate";
  if (whole <= 7) return "High";
  if (whole <= 10) return "Very high";
  return "Extreme";
}

/** The line under the UV index, from the day's highest: "Low all day", or how high it gets, such as "Up to very high". */
export function uvLine(max: number | null | undefined) {
  if (max === null || max === undefined) return "";
  const level = uvLevel(max);
  return level === "Low" ? "Low all day" : `Up to ${level.toLowerCase()}`;
}
