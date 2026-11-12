import {
  durationText,
  midnight,
  onWithin,
  sentence,
  timeText,
  weekday,
  type Day,
  type Span,
} from "./device-history-data";

// What a motion sensor's Motion page says, from the spans and days core
// History gives (device-history-data.ts): motion as on, quiet as off, and
// nothing known while it was offline or before it said anything.

/**
 * The day's spans as the band draws them: one for each stretch of motion,
 * of quiet or of nothing known, however often its settings changed
 * meanwhile.
 */
export function motionSpans(spans: readonly Span[]): Span[] {
  const joined: Span[] = [];
  for (const span of spans) {
    const last = joined.at(-1);
    if (
      last &&
      last.to === span.from &&
      last.known === span.known &&
      last.offline === span.offline &&
      last.on === span.on
    ) {
      joined[joined.length - 1] = { ...last, to: span.to };
    } else {
      joined.push(span);
    }
  }
  return joined;
}

/**
 * The line under the headline, which says what the band shows on its own:
 * "6 h 29 min of motion, the last at 13:56", or while there is motion now,
 * since when.
 */
export function motionSentence(
  spans: readonly Span[],
  from: number,
  now: number,
) {
  const { on, known } = onWithin(spans, from, now);
  if (known === 0) return "Nothing read in the last 24 hours";
  if (on === 0) return "No motion in the last 24 hours";
  const total = `${sentence(durationText(on))} of motion`;
  const last = motionSpans(spans)
    .reverse()
    .find((span) => span.on)!;
  return last.to >= now
    ? `${total}, this time since ${timeText(last.from)}`
    : `${total}, the last at ${timeText(last.to)}`;
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
  return motionSpans(joined);
}

/** What a span is, as the band's readout and a screen reader say it. */
export function motionSpanText(span: Span) {
  if (span.offline) return "Offline";
  if (!span.known) return "Not known";
  return span.on ? "Motion" : "Quiet";
}

/** When a span was, such as "09:05–10:40", or to now. */
export function spanTimes(span: Span, now: number) {
  return `${timeText(span.from)}–${span.to >= now ? "now" : timeText(span.to)}`;
}

/**
 * What the last 7 days come to: about how long there was motion a day,
 * over the days that have ended; until one has, how long there has been
 * motion today; or since when there has been none.
 */
export function motionWeekHeadline(days: readonly Day[], now: number) {
  const today = midnight(now);
  const known = days.filter((day) => day.known > 0);
  if (known.length === 0) return "Not known yet";
  const ended = known.filter((day) => day.start !== today);
  const average =
    ended.reduce((sum, day) => sum + day.on, 0) / Math.max(1, ended.length);
  if (average > 0) {
    const minutes = Math.round(average / 60);
    if (minutes < 1) return "Under a minute a day";
    return minutes < 60
      ? `About ${minutes} min a day`
      : `About ${Math.round(average / 3600)} h a day`;
  }
  const motionToday = known.find((day) => day.start === today)?.on ?? 0;
  if (motionToday > 0) return sentence(`${durationText(motionToday)} today`);
  if (known.length === days.length) return "No motion all week";
  return known[0]!.start === today
    ? "No motion today"
    : `No motion since ${weekday.format(known[0]!.start)}`;
}
