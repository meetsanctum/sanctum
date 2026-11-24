import type { CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";

import { productName } from "./brand";
import {
  Columns,
  Notice,
  Part,
  Readout,
  useDayAndWeek,
  useWidth,
  width,
  type ColumnWords,
} from "./device-history";
import {
  countedDays,
  dayMs,
  daysOf,
  joinedSpans,
  midnight,
  spansOf,
  spanTimes,
  timeText,
  type Day,
  type Span,
} from "./device-history-data";
import { BandMarks, bandHeight, BandTicks } from "./motion-band";
import { Battery } from "./sensor-detail";

// The first page of a sensor that says one thing or its opposite over
// time, a motion sensor's motion or a contact sensor's being open, from
// core History: under "Last 24 hours", what it says now and a sentence
// that says what the band shows on its own; the day as a band, the one as
// White spans, the other as a hairline and nothing where nothing was known;
// and the week as a column of that time a day, as a light's History has,
// or of how often it came on where the sensor's words count that.
// The pointer or the arrow keys show a readout of a span or a day, and
// screen readers get each as a list. Its battery is at the foot, as on a
// sensor's Readings. Which value of its history it reads and every word it
// says are the sensor's own (motion-detail.tsx, contact-detail.tsx).

/** What such a page reads and says for one kind of sensor. */
export type DayAndWeekWords = {
  /** The value of its history that the band draws White. */
  field: "motion" | "open";
  /** What it says now. */
  now: (now: number) => string;
  /** The line under that, which says what the band shows on its own. */
  sentence: (spans: readonly Span[], from: number, now: number) => string;
  /** What the band is, for a screen reader. */
  band: string;
  /** What a span is, in the band's readout. */
  span: (span: Span) => string;
  /** What the last 7 days come to. */
  week: (days: readonly Day[], now: number) => string;
  columns: ColumnWords;
  /**
   * Whether the week counts how often it came on each day, as a door's
   * openings, in place of for how long: its changes are then read over the
   * 7 days.
   */
  counted?: boolean;
};

// How near a White span the pointer has to be to show it, in px: a minute
// of motion is narrower than a pixel.
const snap = 4;

export function DayAndWeek(props: {
  device: DeviceInfo;
  capability: CapabilityInfo;
  words: DayAndWeekWords;
}) {
  const { device, capability, words } = props;
  const { loaded, failed, now, live } = useDayAndWeek(
    device,
    capability,
    words.counted,
  );
  const dayId = useId();
  const from = now - dayMs;
  const spans = loaded ? spansOf(loaded.states, from, now, live) : [];
  const timed = loaded
    ? daysOf(loaded.statistics, spans, now, words.field)
    : [];
  const days =
    loaded && words.counted
      ? countedDays(
          timed,
          spansOf(loaded.states, midnight(now, 6) - 1, now, live),
        )
      : timed;

  return (
    <div
      data-loading={loaded || failed ? undefined : ""}
      className={`${width} flex flex-col gap-10 transition-opacity [--history-width:480px] data-loading:opacity-0`}
    >
      <section aria-labelledby={dayId} className="flex flex-col gap-1">
        <h3
          id={dayId}
          className="m-0 text-[13px] leading-[18px] font-medium text-(--silver)"
        >
          Last 24 hours
        </h3>
        <p className="m-0 text-2xl leading-8 font-light">{words.now(now)}</p>
        {loaded && !loaded.states.kept ? (
          <div className="mt-4">
            <Notice>
              {productName} doesn't keep this device's history. You can change
              that in Settings → Devices.
            </Notice>
          </div>
        ) : failed && !loaded ? (
          <div className="mt-4">
            <Notice>Its history can't be read right now.</Notice>
          </div>
        ) : (
          <>
            <p className="m-0 mb-4 text-[15px] leading-[22px] text-(--silver)">
              {words.sentence(spans, from, now)}
            </p>
            <Band
              spans={joinedSpans(spans).filter((span) => span.to > span.from)}
              from={from}
              to={now}
              label={words.band}
              words={words.span}
            />
          </>
        )}
      </section>
      {loaded?.states.kept && (
        <Part title="Last 7 days" headline={words.week(days, now)}>
          <Columns days={days} now={now} words={words.columns} />
        </Part>
      )}
      <Battery device={device} />
    </div>
  );
}

// Where the band's readout is: a span, and the pointer's place over it, or
// none for the arrow keys, which show it at its middle.
type Cursor = { index: number; x: number | null };

// The day as a band 40 px tall: motion, or being open, as White spans, the
// rest as a hairline along its foot, and nothing where nothing was known.
// The pointer shows the span under it, a White span within a few pixels
// before the rest; the arrow keys step from span to span. A media player's
// History draws its playing as one too (media-history.tsx).
export function Band(props: {
  spans: readonly Span[];
  from: number;
  to: number;
  label: string;
  words: (span: Span) => string;
}) {
  const { spans, from, to, words } = props;
  const { box, width: plot } = useWidth();
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const x = (at: number) => ((at - from) / (to - from)) * plot;
  const index =
    cursor && spans.length > 0 ? Math.min(cursor.index, spans.length - 1) : -1;
  const pointed = index >= 0 ? spans[index] : undefined;

  const spanAt = (left: number) => {
    const near = spans.findIndex(
      (span) =>
        span.on && x(span.from) - snap <= left && left <= x(span.to) + snap,
    );
    if (near >= 0) return near;
    const at = from + (left / Math.max(1, plot)) * (to - from);
    return spans.findIndex((span) => span.from <= at && at < span.to);
  };
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const left =
      event.clientX - event.currentTarget.getBoundingClientRect().left;
    const found = spanAt(Math.max(0, Math.min(plot, left)));
    setCursor(found >= 0 ? { index: found, x: left } : null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (spans.length === 0) return;
    const current = index >= 0 ? index : spans.length - 1;
    const next =
      event.key === "ArrowLeft"
        ? current - 1
        : event.key === "ArrowRight"
          ? current + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? spans.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    setCursor({
      index: Math.max(0, Math.min(spans.length - 1, next)),
      x: null,
    });
  };
  const markAt = pointed
    ? (cursor?.x ?? (x(pointed.from) + x(pointed.to)) / 2)
    : null;

  return (
    <div ref={box} className="relative">
      <div
        tabIndex={0}
        role="group"
        aria-label={props.label}
        className="relative rounded-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        style={{ width: plot, height: bandHeight }}
        onPointerMove={fromPointer}
        onPointerDown={fromPointer}
        onPointerLeave={() => setCursor(null)}
        onFocus={() =>
          setCursor(
            (current) =>
              current ??
              (spans.length > 0 ? { index: spans.length - 1, x: null } : null),
          )
        }
        onBlur={() => setCursor(null)}
        onKeyDown={onKeyDown}
      >
        <BandMarks spans={spans} x={x} plot={plot} pointed={pointed}>
          {pointed && !pointed.on && markAt !== null && (
            <rect
              x={Math.min(plot - 1, Math.round(markAt))}
              y={0}
              width={1}
              height={bandHeight}
              className="fill-white/40"
            />
          )}
        </BandMarks>
        {pointed && markAt !== null && (
          <Readout
            x={markAt}
            width={plot}
            value={words(pointed)}
            about={spanTimes(pointed, to)}
          />
        )}
      </div>
      <BandTicks
        from={from}
        to={to}
        plot={plot}
        className="mt-2 text-(--pewter)"
      />
      <ul className="sr-only">
        {spans.map((span) => (
          <li key={span.from}>
            {timeText(span.from)} to {timeText(span.to)}: {words(span)}
          </li>
        ))}
      </ul>
    </div>
  );
}
