import type { HomeClock } from "@meetsanctum/app-sdk/clock";

import {
  durationText,
  joinedSpans,
  onWithin,
  sensedWeekHeadline,
  sentence,
  type Day,
  type Span,
} from "./device-history-data";

// What a motion sensor's Motion page says, from the spans and days core
// History gives (device-history-data.ts): motion as on, quiet as off, and
// nothing known while it was offline or before it said anything.

/**
 * The line under the headline, which says what the band shows on its own:
 * "6 h 29 min of motion, the last at 13:56", or while there is motion now,
 * since when.
 */
export function motionSentence(
  clock: HomeClock,
  spans: readonly Span[],
  from: number,
  now: number,
) {
  const { on, known } = onWithin(spans, from, now);
  if (known === 0) return "Nothing read in the last 24 hours";
  if (on === 0) return "No motion in the last 24 hours";
  const total = `${sentence(durationText(on))} of motion`;
  const joined = joinedSpans(spans);
  const last = [...joined].reverse().find((span) => span.on)!;
  return last === joined.at(-1) && last.to >= now
    ? `${total}, this time since ${clock.timeText(last.from)}`
    : `${total}, the last at ${clock.timeText(last.to)}`;
}

/**
 * A room's spans from its motion sensors' (Presence's overview): motion
 * while any of them saw it, quiet while any was known and none saw motion,
 * and nothing known while none was, offline while all of them were.
 */
export function roomSpans(
  sensors: readonly (readonly Span[])[],
  from: number,
  to: number,
): Span[] {
  const cuts = new Set([from, to]);
  for (const spans of sensors) {
    for (const span of spans) {
      if (span.from > from && span.from < to) cuts.add(span.from);
      if (span.to > from && span.to < to) cuts.add(span.to);
    }
  }
  const times = [...cuts].sort((a, b) => a - b);
  const joined: Span[] = [];
  for (const [index, start] of times.slice(0, -1).entries()) {
    const here = sensors.flatMap((spans) => {
      const found = spans.find((span) => span.from <= start && start < span.to);
      return found ? [found] : [];
    });
    const known = here.some((span) => span.known);
    joined.push({
      from: start,
      to: times[index + 1]!,
      known,
      offline:
        !known &&
        here.length > 0 &&
        here.length === sensors.length &&
        here.every((span) => span.offline),
      on: here.some((span) => span.known && span.on),
      brightness: null,
      colour: "#ffffff",
    });
  }
  return joinedSpans(joined);
}

/** What a span is, as the band's readout and a screen reader say it. */
export function motionSpanText(span: Span) {
  if (span.offline) return "Offline";
  if (!span.known) return "Not known";
  return span.on ? "Motion" : "Quiet";
}

/**
 * What the last 7 days come to: about how long there was motion a day,
 * over the days that have ended; until one has, how long there has been
 * motion today; or since when there has been none.
 */
export function motionWeekHeadline(
  clock: HomeClock,
  days: readonly Day[],
  now: number,
) {
  return sensedWeekHeadline(clock, days, now, {
    aDay: (about) => sentence(`${about} a day`),
    today: (duration) => sentence(`${duration} today`),
    none: "No motion",
  });
}
