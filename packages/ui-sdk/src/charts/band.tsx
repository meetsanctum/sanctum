import { memo } from "react";

import { TimeTicks } from "./axis";
import { SpokenPin, useCursor } from "./cursor";
import { ChartFoot, plotClass, Readout, useWidth } from "./frame";
import { useHomeClock } from "../home-clock";

// A day as a band 40 px tall: what is on as solid spans, what is faint as a
// faint fill across the band, the rest as a 2 px line along its foot, and
// nothing where nothing was known. As a whole chart it has a hairline along
// its whole foot, which off covers, the time every 6 hours under it, a
// readout a mouse shows or a tap pins (cursor.tsx), and the spans listed for
// screen readers; its marks alone go inside something that is itself the
// control, such as a row's button, with one axis over them all.

/** How a band draws a span. */
export type BandLevel = "on" | "faint" | "off" | "unknown";

/** A span of a day's band, from one time to another, in ms since the epoch. */
export type BandSpan = { from: number; to: number; level: BandLevel };

const bandHeight = 40;

// How near an on span the pointer has to be to show it, in px: a minute of
// it is narrower than a pixel.
const snap = 4;

// The band's marks across `plot` px, the span pointed at in full colour.
const BandRects = memo(function BandRects(props: {
  spans: readonly BandSpan[];
  from: number;
  to: number;
  plot: number;
  page: boolean;
  pointed?: BandSpan;
}) {
  const { spans, from, to, plot, page } = props;
  const faint = page ? "fill-foreground/16" : "fill-white/16";
  const faintPointed = page ? "fill-foreground/24" : "fill-white/24";
  const off = page ? "fill-foreground/30" : "fill-white/30";
  const on = page ? "fill-foreground/70" : "fill-white/70";
  const onPointed = page ? "fill-foreground" : "fill-white";
  const x = (at: number) => ((at - from) / (to - from)) * plot;
  return spans.map((span) => {
    if (span.level === "unknown") return null;
    const left = Math.round(x(span.from));
    const right = Math.round(x(span.to));
    if (span.level === "faint") {
      // Faint across the band, and within it however short.
      const fillWidth = Math.max(1, right - left);
      return (
        <rect
          key={span.from}
          x={Math.min(left, plot - fillWidth)}
          y={0}
          width={fillWidth}
          height={bandHeight}
          className={span === props.pointed ? faintPointed : faint}
        />
      );
    }
    if (span.level === "off") {
      return (
        <rect
          key={span.from}
          x={left}
          y={bandHeight - 2}
          width={Math.max(0, right - left)}
          height={2}
          className={off}
        />
      );
    }
    const spanWidth = Math.max(2, right - left);
    return (
      <rect
        key={span.from}
        x={left}
        y={0}
        width={spanWidth}
        height={bandHeight}
        rx={Math.min(3, spanWidth / 2)}
        className={span === props.pointed ? onPointed : on}
      />
    );
  });
});

/** What a day's band marks take. */
export type DayBandMarksProps = {
  spans: readonly BandSpan[];
  /** When the day starts and ends, in ms since the epoch. */
  from: number;
  to: number;
  /** Its width in px; without one it measures its box. */
  width?: number;
  /** On a device's glass, in White, or on a page, in its ink. */
  tone?: "glass" | "page";
  /** Its box's classes, which size it: `block h-10 w-full` unless said. */
  className?: string;
};

/**
 * A day's band, marks only: no focus, no list and nothing to press, so it
 * can go inside a button. What it shows is for the control around it to say.
 */
export function DayBandMarks(props: DayBandMarksProps) {
  const { box, width } = useWidth<HTMLSpanElement>(props.width);
  return (
    <span
      ref={box}
      aria-hidden="true"
      className={props.className ?? "block h-10 w-full"}
    >
      <svg
        aria-hidden="true"
        width={width}
        height={bandHeight}
        className="block overflow-visible"
      >
        {width > 0 && (
          <BandRects
            spans={props.spans}
            from={props.from}
            to={props.to}
            plot={width}
            page={props.tone === "page"}
          />
        )}
      </svg>
    </span>
  );
}

/** What a day's band chart takes. */
export type DayBandChartProps<Span extends BandSpan> = {
  /** Its spans in time order, each the caller's own, which `text` gets back. */
  spans: readonly Span[];
  /** When the day starts and ends, in ms since the epoch. */
  from: number;
  to: number;
  /** What the band is, for a screen reader. */
  label: string;
  /** What a span is, in the readout and the screen reader's list. */
  text: (span: Span) => string;
  /** When a span was, under its readout: 09:05–10:40, or to now. */
  about?: (span: Span) => string;
  /** A time of day as the chart says it: as the home writes it, 07:30 or 7:30 AM, unless said. */
  time?: (at: number) => string;
  /** Its width in px; without one it measures its box. */
  width?: number;
  /** On a device's glass, in White, or on a page, in its ink. */
  tone?: "glass" | "page";
};

// What a band's cursor points at: a time, and whether it came from a
// pointer, which snaps to an on span a few pixels away.
type BandKey = { at: number; snaps: boolean };

/**
 * A day as a band with its hours under it. The pointer shows an on span
 * under it or within a few pixels, then any other span under it. The arrow
 * keys step from span to span.
 */
export function DayBandChart<Span extends BandSpan>(
  props: DayBandChartProps<Span>,
) {
  const clock = useHomeClock();
  const { spans, from, to, text, time = clock.timeText } = props;
  const page = props.tone === "page";
  const about =
    props.about ??
    ((span: Span) =>
      `${time(span.from)}–${span.to >= to ? "now" : time(span.to)}`);
  const { box, width: plot } = useWidth(props.width);
  const x = (at: number) => ((at - from) / (to - from)) * plot;
  // The span at a time: under a pointer, an on span under it or within a
  // few pixels of it, then any other span under it; from the arrow keys,
  // the span it is in.
  const spanAt = ({ at, snaps }: BandKey) => {
    if (at < from) return -1;
    const left = x(at);
    const inside = spans.findIndex((span) => span.from <= at && at < span.to);
    if (!snaps || spans[inside]?.level === "on") return inside;
    const near = spans.findIndex(
      (span) =>
        span.level === "on" &&
        x(span.from) - snap <= left &&
        left <= x(span.to) + snap,
    );
    return near >= 0 ? near : inside;
  };
  // A pin holds a time inside its span, even if the pointer snapped to it.
  const cursor = useCursor<BandKey>({
    width: plot,
    steps: spans.length,
    keyAt: (step) => {
      const span = spans[step];
      return {
        at: span ? (span.from + span.to) / 2 : Number.NaN,
        snaps: false,
      };
    },
    stepOf: (key) => {
      const found = spanAt(key);
      return found < 0 ? null : found;
    },
    keyAtX: (pointerX, wide) => ({
      at: from + (pointerX / wide) * (to - from),
      snaps: true,
    }),
    keyToPin: ({ at }, step) => {
      const span = spans[step]!;
      // Keep the selected span even when its distance in pixels changes.
      const inside = span.from <= at && at < span.to;
      return {
        at: inside
          ? at
          : (Math.max(span.from, from) + Math.min(span.to, to)) / 2,
        snaps: false,
      };
    },
  });
  const pointed = cursor.step === null ? undefined : spans[cursor.step];
  const markAt = cursor.shown === null ? null : x(cursor.shown.at);
  const pinned = cursor.pinStep === null ? undefined : spans[cursor.pinStep];

  return (
    <div ref={box} className="relative">
      <div
        tabIndex={0}
        role="group"
        aria-label={props.label}
        className={plotClass}
        style={{ width: plot, height: bandHeight }}
        {...cursor.plot}
      >
        <svg
          aria-hidden="true"
          width={plot}
          height={bandHeight}
          className="block overflow-visible"
        >
          <ChartFoot plot={plot} height={bandHeight} page={page} />
          {plot > 0 && (
            <BandRects
              spans={spans}
              from={from}
              to={to}
              plot={plot}
              page={page}
              pointed={pointed}
            />
          )}
          {pointed && pointed.level !== "on" && markAt !== null && (
            <rect
              x={Math.min(plot - 1, Math.round(markAt))}
              y={0}
              width={1}
              height={bandHeight}
              className={page ? "fill-foreground/40" : "fill-white/40"}
            />
          )}
        </svg>
        {pointed && markAt !== null && (
          <Readout
            x={markAt}
            width={plot}
            value={text(pointed)}
            about={about(pointed)}
          />
        )}
      </div>
      <TimeTicks
        from={from}
        to={to}
        plot={plot}
        time={props.time}
        className={page ? "mt-2 text-muted-foreground" : "mt-2 text-(--pewter)"}
      />
      <SpokenPin
        pin={cursor.pin}
        text={pinned ? `${about(pinned)}: ${text(pinned)}` : ""}
      />
      <ul className="sr-only">
        {spans.map((span) => (
          <li key={span.from}>
            {time(span.from)} to {time(span.to)}: {text(span)}
          </li>
        ))}
      </ul>
    </div>
  );
}
