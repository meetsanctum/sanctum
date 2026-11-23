import type {
  Availability,
  CapabilityInfo,
  DeviceHistory,
  DeviceStatistics,
  LightState,
} from "@meetsanctum/app-sdk";
import { lightColour } from "@meetsanctum/ui-sdk";

// What a device's History page shows, from core History: its last day as
// spans, each what it was from one change to the next, and its last week day
// by day, from the hourly roll-ups and the spans for the hour not yet rolled
// up. A motion sensor's and a contact sensor's pages read them as well,
// motion and being open counting as on.

const hourMs = 60 * 60_000;
export const dayMs = 24 * hourMs;

/** What a capability was from `from` until `to`. */
export type Span = {
  from: number;
  to: number;
  /** Nothing is known of it while it is offline, or before it reports. */
  known: boolean;
  offline: boolean;
  /** On; for a motion sensor, seeing motion; for a contact sensor, open. */
  on: boolean;
  /** A dimmable light's brightness while on. */
  brightness: number | null;
  /** A lit light's colour; white for a switch. */
  colour: string;
};

type Recorded = {
  at: number;
  availability: Availability;
  state: Record<string, unknown> | null;
};

/** What the device is now, from the live feed, to carry the last span to now. */
export type Live = {
  availability: Availability;
  state: Record<string, unknown> | null;
  /** When the page first saw it so. */
  since: number;
};

// The field of a kind's state that counts as on, where it is not `on`.
const onFields: Partial<Record<CapabilityInfo["kind"], string>> = {
  motion: "motion",
  contact: "open",
};

function spanOf(
  kind: CapabilityInfo["kind"],
  recorded: Recorded,
  from: number,
  to: number,
): Span {
  const { state } = recorded;
  const known = recorded.availability !== "offline" && state !== null;
  const on = known && state[onFields[kind] ?? "on"] === true;
  return {
    from,
    to,
    known,
    offline: recorded.availability === "offline",
    on,
    brightness:
      on && typeof state.brightness === "number" ? state.brightness : null,
    colour:
      kind === "light" && on
        ? lightColour(state as unknown as LightState)
        : "#ffffff",
  };
}

const sameState = (a: Recorded, b: Omit<Recorded, "at">) =>
  a.availability === b.availability &&
  JSON.stringify(a.state) === JSON.stringify(b.state);

/**
 * The spans from `from` until `to`: what the history says, then what the
 * device is now where that differs from its last change. Before the first
 * change nothing is known, so there is no span. A change exactly at `to`
 * keeps a zero-length span so summaries see it before time has elapsed.
 */
export function spansOf(
  history: Pick<DeviceHistory, "kind" | "states">,
  from: number,
  to: number,
  live: readonly Live[] = [],
): Span[] {
  const recorded: Recorded[] = history.states.map((each) => ({
    ...each,
    at: Date.parse(each.at),
  }));
  for (const change of live) {
    const last = recorded.at(-1);
    // A refreshed history supersedes the changes it already includes.
    if (last && (change.since < last.at || sameState(last, change))) continue;
    recorded.push({ ...change, at: change.since });
  }
  const spans: Span[] = [];
  for (const [index, each] of recorded.entries()) {
    const start = Math.max(each.at, from);
    const end = Math.min(recorded[index + 1]?.at ?? to, to);
    const isCurrent = index === recorded.length - 1 && each.at === to;
    if (end > start || isCurrent) {
      spans.push(spanOf(history.kind, each, start, end));
    }
  }
  return spans;
}

/**
 * The spans as a band draws them: one for each stretch of on, of off or of
 * nothing known, however often something else about it changed meanwhile,
 * such as a motion sensor's settings.
 */
export function joinedSpans(spans: readonly Span[]): Span[] {
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

/** When a span was, such as "09:05–10:40", or to now. */
export function spanTimes(span: Span, now: number) {
  return `${timeText(span.from)}–${span.to >= now ? "now" : timeText(span.to)}`;
}

/** How long the spans were on and known from `from` until `to`, in seconds. */
export function onWithin(spans: readonly Span[], from: number, to: number) {
  let on = 0;
  let known = 0;
  for (const span of spans) {
    const ms = Math.max(0, Math.min(span.to, to) - Math.max(span.from, from));
    if (!span.known) continue;
    known += ms;
    if (span.on) on += ms;
  }
  return { on: on / 1000, known: known / 1000 };
}

/**
 * One day of the week: how long it was on, out of how long it was known,
 * and how often it came on in it, where a week of its changes was read to
 * count that (`countedDays`).
 */
export type Day = { start: number; on: number; known: number; count?: number };

/**
 * The spans that began as it came on, from joined spans: a change from
 * off to on that was seen, as a door opening. One already on at the start,
 * or that came on from nothing known, is not one.
 */
export function comingsOn(joined: readonly Span[]) {
  return joined.filter((span, index) => {
    const before = joined[index - 1];
    return span.on && before?.known === true && !before.on;
  });
}

/**
 * The week's days with how often it came on in each, counted by the day it
 * came on in, from spans including the state before the week's start.
 */
export function countedDays(days: readonly Day[], spans: readonly Span[]) {
  const starts = comingsOn(joinedSpans(spans)).map((span) => span.from);
  return days.map((day) => {
    const end = midnight(day.start, -1);
    return {
      ...day,
      count: starts.filter((at) => at >= day.start && at < end).length,
    };
  });
}

/** Local midnight of the day `at` is in, `daysBack` days before. */
export function midnight(at: number, daysBack = 0) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysBack);
  return date.getTime();
}

/**
 * The last 7 local days, today last: the hourly roll-ups of whether it was
 * on, saw motion or was open, by `field`, and the spans for the time since
 * the last of them.
 */
export function daysOf(
  statistics: Pick<DeviceStatistics, "fields"> | null,
  spans: readonly Span[],
  now: number,
  field: "on" | "motion" | "open" = "on",
): Day[] {
  const hours = statistics?.fields[field] ?? [];
  const rolledUpTo = hours.reduce(
    (latest, hour) => Math.max(latest, Date.parse(hour.start) + hourMs),
    now - dayMs,
  );
  const days: Day[] = [];
  for (let back = 6; back >= 0; back--) {
    const start = midnight(now, back);
    const end = midnight(now, back - 1);
    let on = 0;
    let known = 0;
    for (const hour of hours) {
      // An hour that local midnight splits, as in a zone half an hour off
      // the hour, counts on either side for its share of the hour.
      const at = Date.parse(hour.start);
      const share =
        Math.max(0, Math.min(at + hourMs, end) - Math.max(at, start)) / hourMs;
      on += hour.mean * hour.seconds * share;
      known += hour.seconds * share;
    }
    const tail = onWithin(
      spans,
      Math.max(start, rolledUpTo),
      Math.min(end, now),
    );
    days.push({ start, on: on + tail.on, known: known + tail.known });
  }
  return days;
}

/** A length of time as it reads: "5 h 20 min", "45 min", "under a minute". */
export function durationText(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** What a span says in the chart's readout, as a tile does. */
export function spanText(span: Span | undefined) {
  if (span?.offline) return "Offline";
  if (!span?.known) return "Not known";
  if (!span.on) return "Off";
  return span.brightness === null ? "On" : `${span.brightness}%`;
}

/** Text that starts a line, with its first letter in capitals. */
export const sentence = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

/** A day's name in a column's label, such as Mon. */
export const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short" });

/** What the last 24 hours come to: how long it was on, or since when it has been off. */
export function dayHeadline(spans: readonly Span[], from: number, to: number) {
  const { on, known } = onWithin(spans, from, to);
  if (on > 0) return `On for ${durationText(on)}`;
  const first = spans.find((span) => span.known);
  if (known === 0 || !first) return "Not known yet";
  return first.from > from + 60_000
    ? `Off since ${timeText(first.from)}`
    : "Off the whole time";
}

/**
 * What the last 7 days come to: how long it was on a day, over the days
 * that have ended; until one has, how long it has been on today; or since
 * when it has been off.
 */
export function weekHeadline(days: readonly Day[], now: number) {
  const today = midnight(now);
  const known = days.filter((day) => day.known > 0);
  if (known.length === 0) return "Not known yet";
  const ended = known.filter((day) => day.start !== today);
  const average =
    ended.reduce((sum, day) => sum + day.on, 0) / Math.max(1, ended.length);
  if (average > 0) return sentence(`${durationText(average)} a day`);
  const onToday = known.find((day) => day.start === today)?.on ?? 0;
  if (onToday > 0) return `On for ${durationText(onToday)} today`;
  if (known.length === days.length) return "Off all week";
  return known[0]!.start === today
    ? "Off today"
    : `Off since ${weekday.format(known[0]!.start)}`;
}

/** The words a sensor's week comes to, for what counts as on. */
export type WeekWords = {
  /** About how long a day, from "about 40 min": "About 40 min a day". */
  aDay: (about: string) => string;
  /** How long today, until a day has ended: "14 min today". */
  today: (duration: string) => string;
  /** While it never was, before "all week", "today" and "since Mon". */
  none: string;
};

/**
 * What a sensor's last 7 days come to: about how long a day it saw motion
 * or was open, over the days that have ended; until one has, how long
 * today; or since when not at all.
 */
export function sensedWeekHeadline(
  days: readonly Day[],
  now: number,
  words: WeekWords,
) {
  const today = midnight(now);
  const known = days.filter((day) => day.known > 0);
  if (known.length === 0) return "Not known yet";
  const ended = known.filter((day) => day.start !== today);
  const average =
    ended.reduce((sum, day) => sum + day.on, 0) / Math.max(1, ended.length);
  if (average > 0) {
    const minutes = Math.round(average / 60);
    return words.aDay(
      minutes < 1
        ? "under a minute"
        : minutes < 60
          ? `about ${minutes} min`
          : `about ${Math.round(average / 3600)} h`,
    );
  }
  const onToday = known.find((day) => day.start === today)?.on ?? 0;
  if (onToday > 0) return words.today(durationText(onToday));
  if (known.length === days.length) return `${words.none} all week`;
  return known[0]!.start === today
    ? `${words.none} today`
    : `${words.none} since ${weekday.format(known[0]!.start)}`;
}

/** The words a week of counts comes to, for what is counted. */
export type CountWords = {
  /** About how often a day, from "about 6 times": "Opened about 6 times a day". */
  aDay: (about: string) => string;
  /** How often in all: "Opened once", "Opened 3 times". */
  times: (count: number) => string;
  /** While it never did, before "all week", "today" and "since Mon". */
  none: string;
};

/**
 * What a week of counts comes to: about how often a day, over the days
 * that have ended, once that is at least once a day; otherwise how often
 * in all, this week, today or since the first day known; or since when not
 * at all.
 */
export function countedWeekHeadline(
  days: readonly Day[],
  now: number,
  words: CountWords,
) {
  const today = midnight(now);
  const known = days.filter((day) => day.known > 0 || (day.count ?? 0) > 0);
  if (known.length === 0) return "Not known yet";
  const count = (some: readonly Day[]) =>
    some.reduce((sum, day) => sum + (day.count ?? 0), 0);
  const total = count(known);
  const isWholeWeek = known.length === days.length;
  const since =
    known[0]!.start === today
      ? "today"
      : `since ${weekday.format(known[0]!.start)}`;
  if (total === 0) {
    return `${words.none} ${isWholeWeek ? "all week" : since}`;
  }
  const ended = known.filter((day) => day.start !== today);
  const average = count(ended) / Math.max(1, ended.length);
  if (average >= 1) {
    const rounded = Math.round(average);
    return words.aDay(rounded === 1 ? "about once" : `about ${rounded} times`);
  }
  return `${words.times(total)} ${isWholeWeek ? "this week" : since}`;
}

/** A time of day as Automations writes it, such as 07:30. */
export function timeText(at: number) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "Invalid Date";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
