import {
  durationText,
  joinedSpans,
  midnight,
  onWithin,
  sensedWeekHeadline,
  timeText,
  type Day,
  type Span,
} from "./device-history-data";

// What a contact sensor's page says, from the spans and days core History
// gives (device-history-data.ts): open as on, closed as off, and nothing
// known while it was offline or before it said anything.

/**
 * The line under the headline, which says what the band shows on its own:
 * "Opened 6 times, 14 min in all, the last at 13:52". An opening is a
 * change from closed to open within the day: one that was already open
 * when the day began, or whose start was not seen, adds to the time and
 * not to the count. "Not opened" is said only of a day known throughout.
 */
export function contactSentence(
  spans: readonly Span[],
  from: number,
  now: number,
) {
  const { on, known } = onWithin(spans, from, now);
  const whole = (now - from) / 1000;
  const joined = joinedSpans(spans);
  const last = [...joined].reverse().find((span) => span.on);
  if (!last) {
    if (known === 0) return "Nothing read in the last 24 hours";
    return known >= whole
      ? "Not opened in the last 24 hours"
      : "Not seen open in the last 24 hours";
  }
  const isOpenNow = last === joined.at(-1) && last.to >= now;
  if (on >= whole && isOpenNow) return "Open the whole time";
  const openings = joined.filter((span, index) => {
    const before = joined[index - 1];
    return span.on && before?.known === true && !before.on;
  });
  const total = `${durationText(on)} in all`;
  if (openings.length === 0) {
    return isOpenNow
      ? `Open ${total}`
      : `Open ${total}, until ${timeText(last.to)}`;
  }
  const counted = `Opened ${openings.length === 1 ? "once" : `${openings.length} times`}, ${total}`;
  return isOpenNow
    ? `${counted}, this time since ${timeText(last.from)}`
    : `${counted}, the last at ${timeText(openings.at(-1)!.from)}`;
}

/** What a span is, as the band's readout and a screen reader say it. */
export function contactSpanText(span: Span) {
  if (span.offline) return "Offline";
  if (!span.known) return "Not known";
  return span.on ? "Open" : "Closed";
}

/**
 * What the last 7 days come to: about how long it was open a day, over the
 * days that have ended; until one has, how long today; or since when it
 * has not been open.
 */
export function contactWeekHeadline(days: readonly Day[], now: number) {
  const firstKnown = days.find((day) => day.known > 0);
  const isKnownThroughout =
    firstKnown !== undefined &&
    days
      .filter((day) => day.start >= firstKnown.start)
      .every(
        (day) =>
          day.known >=
          (Math.min(midnight(day.start, -1), now) - day.start) / 1000,
      );
  return sensedWeekHeadline(days, now, {
    aDay: (about) => `Open ${about} a day`,
    today: (duration) => `Open for ${duration} today`,
    none: isKnownThroughout ? "Not opened" : "Not seen open",
  });
}
