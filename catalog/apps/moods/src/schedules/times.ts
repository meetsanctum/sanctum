// Times of a room's schedule, in minutes from midnight in 15-minute steps:
// v1's room schedules (room-schedules.ts in web-nuxt, room-schedule-configs.ts
// in the core, Pragmata v1-final), with a time that runs past midnight
// kept as one rather than split in two. Moods' actions and its pages share
// it, so it imports nothing at run time.

/** Minutes in a day; an end of 1440 is midnight. */
export const day = 1440;
/** The steps a time takes, as in v1. */
export const step = 15;

/** When a scheduled mood holds: from its start to its end, past midnight when the end is not after the start. */
export type Span = { start: number; end: number };

/** Whether a minute is a time a span may start at: 00:00 to 23:45. */
export const isStart = (minute: number) =>
  Number.isInteger(minute) &&
  minute >= 0 &&
  minute < day &&
  minute % step === 0;

/** Whether a minute is a time a span may end at: 00:15 to 24:00. */
export const isEnd = (minute: number) =>
  Number.isInteger(minute) &&
  minute > 0 &&
  minute <= day &&
  minute % step === 0;

/** Such as 07:45; midnight as an end is 24:00. */
export function formatMinute(minute: number) {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Whether a span runs past midnight. */
export const isOvernight = (span: Span) => span.end <= span.start;

/** How long a span lasts, in minutes. */
export const lengthOf = (span: Span) =>
  isOvernight(span) ? day - span.start + span.end : span.end - span.start;

/** The parts of one day a span covers: one, or two when it runs past midnight. */
export function windowsOf(span: Span): Span[] {
  if (!isOvernight(span)) return [{ start: span.start, end: span.end }];
  return [
    { start: span.start, end: day },
    ...(span.end > 0 ? [{ start: 0, end: span.end }] : []),
  ];
}

/** Whether a span holds at a minute of the day (0 to 1439). */
export const holds = (span: Span, minute: number) =>
  windowsOf(span).some((part) => part.start <= minute && minute < part.end);

/** The span that holds at a minute, if one does (v1's currentRoomScheduleConfigEntry). */
export function spanAt<T extends Span>(
  spans: readonly T[],
  minute: number,
): T | undefined {
  return spans.find((span) => holds(span, minute));
}

/** Whether two spans share any minute. */
export function overlaps(a: Span, b: Span) {
  return windowsOf(a).some((one) =>
    windowsOf(b).some(
      (other) => one.start < other.end && other.start < one.end,
    ),
  );
}

/** Spans in the order of the day, by start. */
export function byStart<T extends Span>(spans: readonly T[]): T[] {
  return [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * The ends a span from this start may take, in order: each step after it,
 * past midnight, until another span begins (v1 let any end be picked and
 * refused an overlap on saving). None when another span holds the start.
 */
export function endsFrom(spans: readonly Span[], start: number): number[] {
  if (spans.some((span) => holds(span, start))) return [];
  const ends: number[] = [];
  for (let at = start + step; at <= start + day; at += step) {
    const minute = (at - step) % day;
    if (spans.some((span) => holds(span, minute))) break;
    const end = at <= day ? at : at - day;
    // A whole day only from midnight, so a start and its end differ.
    if (end === start) break;
    ends.push(end);
  }
  return ends;
}

// The parts of the day the spans cover, merged and in order.
function covered(spans: readonly Span[]): Span[] {
  const parts = spans.flatMap(windowsOf).sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const part of parts) {
    const last = merged.at(-1);
    if (last && part.start <= last.end) {
      last.end = Math.max(last.end, part.end);
    } else {
      merged.push({ ...part });
    }
  }
  return merged;
}

function freeWindow(taken: readonly Span[], from: number, length: number) {
  let start = from;
  for (const part of taken) {
    if (part.end <= start) continue;
    if (part.start - start >= length) return { start, end: start + length };
    start = Math.max(start, part.end);
  }
  return day - start >= length ? { start, end: start + length } : null;
}

const preferredLength = 60;
const defaultStart = 7 * 60;

/**
 * Where a new span goes first (v1's nextAvailableScheduleWindow): an hour
 * at 07:00 in an empty schedule, else the first free hour after the latest
 * end, then from midnight, then a free quarter of an hour; none when the
 * day is full.
 */
export function nextFreeWindow(spans: readonly Span[]): Span | null {
  const taken = covered(spans);
  if (taken.length === 0) {
    return { start: defaultStart, end: defaultStart + preferredLength };
  }
  const latest = Math.max(...taken.map((part) => part.end));
  return (
    freeWindow(taken, latest, preferredLength) ??
    freeWindow(taken, 0, preferredLength) ??
    freeWindow(taken, latest, step) ??
    freeWindow(taken, 0, step)
  );
}

/** The minute of the day it is at an instant in a time zone. */
export function minuteIn(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
  }).formatToParts(at);
  const part = (type: string) =>
    Number(parts.find((each) => each.type === type)?.value ?? 0);
  return (part("hour") % 24) * 60 + part("minute");
}
