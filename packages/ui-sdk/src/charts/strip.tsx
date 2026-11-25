import { Fragment, memo, useMemo } from "react";

import { TimeTicks } from "./axis";
import { SpokenPin, useCursor } from "./cursor";
import { plotClass, Readout, useWidth } from "./frame";
import { useHomeClock } from "../home-clock";

// A day as a strip: each span on filled in its own colour, as high as its
// level where the strip shows levels, off as a hairline along its foot and
// nothing where nothing was known, with the time every 6 hours under it.
// It shows its value under a mouse or where a tap or the arrow keys pin it,
// in quarter hours, and lists its spans for screen readers.

/**
 * How a strip draws a span: nothing known, off, or on in a colour, filled
 * as high as its level from 0 to 100, or all the way without one.
 */
export type StripMark =
  "unknown" | "off" | { level: number | null; colour: string };

/** A span of a day's strip, from one time to another, in ms since the epoch. */
export type StripSpan = { from: number; to: number; mark: StripMark };

// The strip's heights, with levels and without, and the gutter for its
// 100% where it shows levels.
const levelsHeight = 88;
const flatHeight = 40;
const gutter = 40;
// The strip's cursor moves in quarter hours.
const quarters = 24 * 4;

type MarkLayer = {
  off: string;
  on: Map<string, { fill: string; top: string }>;
};

// Batch disjoint marks by colour. Each span is at least a pixel wide, so
// spans starting at the same pixel need separate layers in time order to
// keep their colours and top edges in the right order.
function marksOf(
  spans: readonly StripSpan[],
  x: (at: number) => number,
  height: number,
  levels: boolean,
) {
  const layers: MarkLayer[] = [];
  let previousLeft = -1;
  let index = 0;
  for (const span of spans) {
    if (span.mark === "unknown") continue;
    const left = x(span.from);
    const width = Math.max(left + 1, x(span.to)) - left;
    index = left === previousLeft ? index + 1 : 0;
    previousLeft = left;
    const layer = (layers[index] ??= { off: "", on: new Map() });
    if (span.mark === "off") {
      layer.off += `M${left} ${height - 1}h${width}v1h${-width}z`;
      continue;
    }
    const { level: shown, colour } = span.mark;
    const level =
      !levels || shown === null
        ? height
        : Math.max(2, Math.round((height * shown) / 100));
    const each = layer.on.get(colour) ?? { fill: "", top: "" };
    each.fill += `M${left} ${height - level}h${width}v${level}h${-width}z`;
    each.top += `M${left} ${height - level}h${width}v2h${-width}z`;
    layer.on.set(colour, each);
  }
  return layers;
}

const StripMarks = memo(function StripMarks(props: {
  layers: readonly MarkLayer[];
}) {
  return props.layers.map(({ off, on }, index) => (
    <Fragment key={index}>
      {off && <path d={off} className="fill-white/14" />}
      {[...on].map(([colour, each]) => (
        <Fragment key={colour}>
          <path d={each.fill} fill={colour} fillOpacity={0.4} />
          <path d={each.top} fill={colour} />
        </Fragment>
      ))}
    </Fragment>
  ));
});

/** What a span says by default: Not known, Off, On or its level, as 40%. */
function markText(span: StripSpan | undefined) {
  if (!span || span.mark === "unknown") return "Not known";
  if (span.mark === "off") return "Off";
  return span.mark.level === null ? "On" : `${span.mark.level}%`;
}

/** What a day's strip chart takes. */
export type DayStripChartProps<Span extends StripSpan> = {
  /** Its spans in time order, each the caller's own, which `text` gets back. */
  spans: readonly Span[];
  /** When the day starts and ends, in ms since the epoch. */
  from: number;
  to: number;
  /**
   * Whether it fills each span as high as its level, on a taller strip
   * with its 100% at the top right; without, every span on fills it.
   */
  levels?: boolean;
  /** What the strip is, for a screen reader: Brightness, or On and off, over the last 24 hours unless said. */
  label?: string;
  /** What a span is, or the time without one, in the readout and the screen reader's list. */
  text?: (span: Span | undefined) => string;
  /** The top of a strip with levels: 100% unless said. */
  full?: string;
  /** A time of day as the chart says it: as the home writes it, 07:30 or 7:30 AM, unless said. */
  time?: (at: number) => string;
  /** Its width in px; without one it measures its box. */
  width?: number;
};

/** A day as a strip of spans on and off, in their colours and levels. */
export function DayStripChart<Span extends StripSpan>(
  props: DayStripChartProps<Span>,
) {
  const clock = useHomeClock();
  const {
    spans,
    from,
    to,
    levels = false,
    text = markText,
    time = clock.timeText,
  } = props;
  const { box, width } = useWidth(props.width);
  const plot = Math.max(0, width - (levels ? gutter : 0));
  const quarterMs = (to - from) / quarters;
  // A step points at its quarter hour's middle, a time that stays as the
  // day moves on.
  const keyAt = (step: number) => from + (step + 0.5) * quarterMs;
  const cursor = useCursor<number>({
    width: plot,
    steps: quarters,
    keyAt,
    stepOf: (at) =>
      at < from || at >= to
        ? null
        : Math.min(quarters - 1, Math.floor((at - from) / quarterMs)),
    keyAtX: (pointerX, wide) =>
      keyAt(Math.min(quarters - 1, Math.floor((pointerX / wide) * quarters))),
  });
  const height = levels ? levelsHeight : flatHeight;
  const x = (at: number) => Math.round(((at - from) / (to - from)) * plot);
  const layers = useMemo(
    () =>
      marksOf(
        spans,
        (at) => Math.round(((at - from) / (to - from)) * plot),
        height,
        levels,
      ),
    [spans, from, to, plot, height, levels],
  );
  const spanAt = (at: number) =>
    spans.find((span) => span.from <= at && at < span.to);
  const pointed = cursor.shown;
  const pointedSpan = pointed === null ? undefined : spanAt(pointed);
  const pointedMark = pointedSpan?.mark;

  return (
    <div ref={box} className="relative">
      <div
        tabIndex={0}
        role="group"
        aria-label={
          props.label ??
          `${levels ? "Brightness" : "On and off"} over the last 24 hours`
        }
        className={plotClass}
        style={{ width: plot, height }}
        {...cursor.plot}
      >
        <svg
          aria-hidden="true"
          width={plot}
          height={height}
          className="block overflow-visible"
        >
          {levels && (
            <rect
              x={0}
              y={0}
              width={plot}
              height={1}
              className="fill-white/8"
            />
          )}
          {plot > 0 && <StripMarks layers={layers} />}
          {pointed !== null && (
            <rect
              x={Math.min(plot - 1, x(pointed))}
              y={0}
              width={1}
              height={height}
              className="fill-white/40"
            />
          )}
        </svg>
        {pointed !== null && (
          <Readout
            x={x(pointed)}
            width={plot}
            value={text(pointedSpan)}
            about={time(pointed)}
            colour={
              typeof pointedMark === "object" ? pointedMark.colour : undefined
            }
          />
        )}
      </div>
      {levels && (
        <span
          aria-hidden="true"
          className="absolute top-0 right-0 -translate-y-1/2 text-[13px] leading-[18px] text-(--pewter) tabular-nums"
        >
          {props.full ?? "100%"}
        </span>
      )}
      <TimeTicks
        from={from}
        to={to}
        plot={plot}
        time={props.time}
        className="mt-2 text-(--pewter)"
      />
      <SpokenPin
        pin={cursor.pin}
        text={
          cursor.pin === null
            ? ""
            : `${time(cursor.pin)}: ${text(spanAt(cursor.pin))}`
        }
      />
      <ul className="sr-only">
        {spans.map((span) => (
          // One text each, not one for every part of it.
          <li key={span.from}>
            {`${time(span.from)} to ${time(span.to)}: ${text(span)}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
