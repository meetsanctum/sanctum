import {
  addDays,
  type HomeClock,
  type LocalDate,
} from "@meetsanctum/app-sdk/clock";

import { day, isOvernight, type Span } from "./times.js";

/** The scheduled span that holds at an instant, and when it stops holding. */
export function activeSpan<T extends Span>(
  spans: readonly T[],
  now: Date,
  clock: HomeClock,
) {
  if (spans.length === 0) return;
  const today = clock.parts(now);
  const at = (date: LocalDate, minute: number) =>
    clock.at(date, Math.floor(minute / 60), minute % 60);

  let latest: { span: T; date: LocalDate; start: Date } | undefined;
  let next: Date | undefined;
  for (const date of [addDays(today, -1), today]) {
    for (const span of spans) {
      const start = at(date, span.start);
      if (start > now) {
        if (!next || start < next) next = start;
      } else if (!latest || start >= latest.start) {
        latest = { span, date, start };
      }
    }
  }
  if (!latest) return;
  const { span, date } = latest;
  const endDate =
    isOvernight(span) || span.end === day ? addDays(date, 1) : date;
  const end = at(endDate, span.end % day);
  if (now >= end) return;

  // A start can cut a span short when the clocks move. Once replaced, that
  // span stays over even after its replacement ends.
  let until = next && next < end ? next : end;
  if (until.getTime() > clock.startOfDay(now.getTime(), -1)) {
    const tomorrow = addDays(today, 1);
    for (const span of spans) {
      const start = at(tomorrow, span.start);
      if (start < until) until = start;
    }
  }
  return { span, until };
}
