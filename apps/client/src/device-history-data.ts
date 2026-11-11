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
// up. A motion sensor's Motion page reads them as well, motion counting as
// on.

const hourMs = 60 * 60_000;
export const dayMs = 24 * hourMs;

/** What a capability was from `from` until `to`. */
export type Span = {
  from: number;
  to: number;
  /** Nothing is known of it while it is offline, or before it reports. */
  known: boolean;
  offline: boolean;
  /** On, or for a motion sensor, seeing motion. */
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

function spanOf(
  kind: CapabilityInfo["kind"],
  recorded: Recorded,
  from: number,
  to: number,
): Span {
  const { state } = recorded;
  const known = recorded.availability !== "offline" && state !== null;
  const on =
    known && (kind === "occupancy" ? state.occupied : state.on) === true;
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
 * change nothing is known, so there is no span.
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
    if (end > start) spans.push(spanOf(history.kind, each, start, end));
  }
  return spans;
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

/** One day of the week: how long it was on, out of how long it was known. */
export type Day = { start: number; on: number; known: number };

/** Local midnight of the day `at` is in, `daysBack` days before. */
export function midnight(at: number, daysBack = 0) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysBack);
  return date.getTime();
}

/**
 * The last 7 local days, today last: the hourly roll-ups of whether it was
 * on, or for a motion sensor whether it saw motion, and the spans for the
 * time since the last of them.
 */
export function daysOf(
  statistics: Pick<DeviceStatistics, "fields"> | null,
  spans: readonly Span[],
  now: number,
  field: "on" | "occupied" = "on",
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

/** A time of day as Automations writes it, such as 07:30. */
export function timeText(at: number) {
  return new Date(at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
