import {
  durationText,
  joinedSpans,
  midnight,
  onWithin,
  spanTimes,
  timeText,
  weekday,
  type Day,
  type Span,
} from "./device-history-data";

// What a media player's History says, from the spans and days core History
// gives (device-history-data.ts): playing as on, and for a player with
// power, whether it was on, playing or not. It says how long it played,
// never what or how loud, which history doesn't keep.

/** How long it was on, playing or not, from `from` until `to`, in seconds. */
export function poweredWithin(
  spans: readonly Span[],
  from: number,
  to: number,
) {
  let on = 0;
  for (const span of spans) {
    if (!span.known || !span.powered) continue;
    on += Math.max(0, Math.min(span.to, to) - Math.max(span.from, from));
  }
  return on / 1000;
}

/**
 * What the last 24 hours come to: how long it played, or since when
 * nothing has.
 */
export function playedHeadline(
  spans: readonly Span[],
  from: number,
  to: number,
) {
  const { on, known } = onWithin(spans, from, to);
  if (on > 0) return `Played ${durationText(on)}`;
  const first = spans.find((span) => span.known);
  if (known === 0 || !first) return "Not known yet";
  return first.from > from + 60_000
    ? `Nothing played since ${timeText(first.from)}`
    : "Nothing played";
}

/**
 * The line under the headline. Offline now, since when. A player with
 * power: how long it was on, playing or not. One without: since when it has
 * been playing, when it last played within the day, or on which day of the
 * week it last did; nothing where it hasn't all week.
 */
export function mediaSentence(
  spans: readonly Span[],
  days: readonly Day[],
  from: number,
  now: number,
  hasPower: boolean,
) {
  const joined = joinedSpans(spans).filter(
    (span) => span.to > span.from || span.to >= now,
  );
  const latest = joined.at(-1);
  if (latest?.offline) {
    return latest.from > from
      ? `Offline since ${timeText(latest.from)}`
      : "Offline the whole time";
  }
  if (!joined.some((span) => span.known)) return null;
  if (hasPower) {
    const on = poweredWithin(spans, from, now);
    if (on > 0) return `On for ${durationText(on)}`;
    const first = joined.find((span) => span.known)!;
    return first.from > from + 60_000
      ? `Off since ${timeText(first.from)}`
      : "Off the whole time";
  }
  const played = [...joined].reverse().find((span) => span.on);
  if (played && played === latest && played.to >= now) {
    return played.from > from
      ? `Playing since ${timeText(played.from)}`
      : "Playing the whole time";
  }
  if (played) return `Last played ${spanTimes(played, now)}`;
  const today = midnight(now);
  const lastDay = [...days]
    .reverse()
    .find((day) => day.start !== today && day.on > 0);
  return lastDay ? `Last played on ${weekday.format(lastDay.start)}` : null;
}

/** What a span is, as the band's readout and a screen reader say it. */
export function mediaSpanText(span: Span) {
  if (span.offline) return "Offline";
  if (!span.known) return "Not known";
  if (span.on) return "Playing";
  if (span.powered === undefined) return "Not playing";
  return span.powered ? "On" : "Off";
}

/**
 * About how long a day it played, near enough to read at a glance: to the
 * minute under 10 minutes, to 5 minutes above.
 */
export function aboutDuration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 10) return durationText(seconds);
  return durationText(Math.round(minutes / 5) * 5 * 60);
}

/**
 * What the last 7 days come to: about how long it played a day, over the
 * days that have ended; until one has, how long today; or since when
 * nothing has played.
 */
export function playedWeekHeadline(days: readonly Day[], now: number) {
  const today = midnight(now);
  const known = days.filter((day) => day.known > 0);
  if (known.length === 0) return "Not known yet";
  const ended = known.filter((day) => day.start !== today);
  const average =
    ended.reduce((sum, day) => sum + day.on, 0) / Math.max(1, ended.length);
  if (average > 0) return `Played about ${aboutDuration(average)} a day`;
  const onToday = known.find((day) => day.start === today)?.on ?? 0;
  if (onToday > 0) return `Played ${durationText(onToday)} today`;
  if (known.length === days.length) return "Nothing played all week";
  return known[0]!.start === today
    ? "Nothing played today"
    : `Nothing played since ${weekday.format(known[0]!.start)}`;
}
