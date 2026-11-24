import { cn } from "cn";
import { memo, useId, useMemo } from "react";

import { plotClass, Readout, useCursor, useWidth } from "./frame";
import { scaleOf, type ChartScale } from "./scale";
import { dayMs, hourMs, sixHours, timeText } from "./time";

// A day as a line through each 5 minutes' mean, such as a sensor's reading.
// It is broken where nothing was known, has two or three faint gridlines with
// their values at the right and the hours every 6 below, and shows its value
// under the pointer or, with the arrow keys, under a cursor; screen readers
// get each hour's mean as a list. On glass it is drawn in White; on a page,
// in the page's ink.

const slots = 24 * 12;
const slotMs = dayMs / slots;

/** One reading on a line: a 5 minutes' mean at its middle, or what it reads now. */
export type LinePoint = { at: number; value: number };

/** How a chart shows its values: in the unit shown, its gridlines' labels, and the gutter they take. */
export type ChartFormat = {
  gutter: number;
  shown: (value: number) => number;
  text: (value: number) => string;
  grid: (shownValue: number) => string;
};

/** Each hour's mean of the day, for a screen reader, which a line of 5 minutes would drown. */
export function hourlyMeans(runs: readonly (readonly LinePoint[])[]) {
  const hours = new Map<number, { sum: number; count: number }>();
  for (const point of runs.flat()) {
    const hour = Math.floor(point.at / hourMs) * hourMs;
    const each = hours.get(hour) ?? { sum: 0, count: 0 };
    each.sum += point.value;
    each.count += 1;
    hours.set(hour, each);
  }
  return [...hours].map(([at, each]) => ({ at, value: each.sum / each.count }));
}

// The line's gridlines and runs, apart from the cursor, which a pointer
// moves without drawing them again.
const LineMarks = memo(function LineMarks(props: {
  runs: readonly (readonly LinePoint[])[];
  from: number;
  plot: number;
  height: number;
  scale: ChartScale | null;
  shown: (value: number) => number;
  above?: number;
  page: boolean;
}) {
  const { from, plot, height, scale, shown, page } = props;
  const clip = useId();
  const x = (at: number) => ((at - from) / dayMs) * plot;
  const yOfShown = (shownValue: number) => yOn(scale, height, shownValue);
  const y = (value: number) => yOfShown(shown(value));
  const runs = props.runs.map((run) =>
    run.length === 1 ? (
      <circle
        key={run[0]!.at}
        cx={x(run[0]!.at)}
        cy={y(run[0]!.value)}
        r={1.5}
      />
    ) : (
      <polyline
        key={run[0]!.at}
        fill="none"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={run.map((each) => `${x(each.at)},${y(each.value)}`).join(" ")}
      />
    ),
  );
  return (
    <>
      {scale?.lines.map((value) => (
        <rect
          key={value}
          x={0}
          y={gridYOn(scale, height, value) - 0.5}
          width={plot}
          height={1}
          className={page ? "fill-foreground/12" : "fill-white/12"}
        />
      ))}
      <g
        className={cn(
          page ? "stroke-foreground/85" : "stroke-white/85",
          page ? "fill-foreground/85" : "fill-white/85",
        )}
      >
        {runs}
      </g>
      {props.above !== undefined && (
        <>
          <clipPath id={clip}>
            <rect
              x={0}
              y={-4}
              width={plot}
              height={Math.max(0, yOfShown(props.above) + 4)}
            />
          </clipPath>
          <g
            clipPath={`url(#${clip})`}
            className="fill-(--danger) stroke-(--danger)"
          >
            {runs}
          </g>
        </>
      )}
    </>
  );
});

// Where a value in the unit shown sits, from the top, kept within the scale.
function yOn(scale: ChartScale | null, height: number, shownValue: number) {
  return scale
    ? height -
        ((Math.min(scale.max, Math.max(scale.min, shownValue)) - scale.min) /
          (scale.max - scale.min)) *
          height
    : height / 2;
}

// A gridline's middle, on a pixel's so it is sharp at 1×.
const gridYOn = (scale: ChartScale | null, height: number, value: number) =>
  Math.round(yOn(scale, height, value)) + 0.5;

/** What a day's line chart takes. */
export type LineChartProps = {
  /** The line in its runs, each broken off where nothing was known, in time order. */
  runs: readonly (readonly LinePoint[])[];
  /** When the day ends; a point at `now` is what it reads now, a step of its own. */
  now: number;
  format: ChartFormat;
  /** What it charts, as its label says it: Temperature. */
  name: string;
  height: number;
  /**
   * Fixed bounds where they mean something, in the unit shown; otherwise
   * round ones around what it read.
   */
  scale?: ChartScale;
  /** Past this value, in the unit shown, the line turns the danger colour. */
  above?: number;
  /** On a device's glass, in White, or on a page, in its ink. */
  tone?: "glass" | "page";
  /** The hours under it; charts stacked on one time axis show them once. */
  hours?: boolean;
  /** What it is, for a screen reader: its name over the last 24 hours unless said. */
  label?: string;
  /** The readout where nothing was read: Not known unless said. */
  unknown?: string;
  /** The readout's time for what it reads now: Now unless said. */
  nowText?: string;
  /** A time of day as the chart says it: 07:30 unless said. */
  time?: (at: number) => string;
  /** Its width in px; without one it measures its box. */
  width?: number;
};

/** A day as a line, with its gridlines, hours and a cursor. */
export function LineChart(props: LineChartProps) {
  const { runs, now, format, height, time = timeText } = props;
  const page = props.tone === "page";
  const { box, width } = useWidth(props.width);
  const points = useMemo(() => runs.flat(), [runs]);
  // What it reads now, where the line ends: a step of its own after the
  // day's 5 minutes, so the last of them stays within the cursor's reach.
  const live = points.find((each) => each.at === now);
  const kept = useMemo(
    () => (live ? points.filter((each) => each !== live) : points),
    [points, live],
  );
  const plot = Math.max(0, width - format.gutter);
  const from = now - dayMs;
  // The pointer keeps to the line's own 5 minutes; Now takes where it is
  // nearer the live reading than the last 5 minutes kept, never more than
  // half of one 5 minutes, so an empty day or a gap doesn't read Now, and
  // always the last pixel, however near the two are.
  const lastKept = kept.at(-1)?.at ?? now;
  const nowFrom = Math.max((lastKept + now) / 2, now - slotMs / 2);
  const cursor = useCursor(slots + (live ? 1 : 0), (pointerX, wide) => {
    const nearer = ((nowFrom - from) / dayMs) * wide;
    if (live && pointerX >= Math.min(nearer, wide - 1)) return slots;
    return Math.min(slots - 1, Math.floor((pointerX / wide) * slots));
  });
  const given = props.scale;
  const scale = useMemo(() => {
    if (given) return given;
    const shown = points.map((each) => format.shown(each.value));
    return shown.length > 0
      ? scaleOf(Math.min(...shown), Math.max(...shown))
      : null;
  }, [given, points, format]);
  const means = useMemo(() => hourlyMeans(runs), [runs]);
  const x = (at: number) => ((at - from) / dayMs) * plot;
  const y = (value: number) => yOn(scale, height, format.shown(value));
  const atNow = live !== undefined && cursor.at === slots;
  const pointedAt =
    cursor.at === null
      ? null
      : atNow
        ? now
        : from + ((cursor.at + 0.5) / slots) * dayMs;
  // The reading nearest the cursor, within its 5 minutes, or at its last
  // step what it reads now.
  const pointed =
    pointedAt === null
      ? undefined
      : atNow
        ? live
        : kept
            .filter((each) => Math.abs(each.at - pointedAt) <= slotMs / 2)
            .sort(
              (a, b) => Math.abs(a.at - pointedAt) - Math.abs(b.at - pointedAt),
            )[0];
  const ticks = sixHours(from, now).filter(
    (at) => x(at) > 20 && x(at) < plot - 20,
  );
  const label = page ? "text-muted-foreground" : "text-(--pewter)";

  return (
    <div ref={box} className="relative">
      <div
        tabIndex={0}
        role="group"
        aria-label={props.label ?? `${props.name} over the last 24 hours`}
        className={plotClass}
        style={{ width: plot, height }}
        {...cursor.handlers(plot)}
      >
        <svg
          aria-hidden="true"
          width={plot}
          height={height}
          className="block overflow-visible"
        >
          {plot > 0 && (
            <LineMarks
              runs={runs}
              from={from}
              plot={plot}
              height={height}
              scale={scale}
              shown={format.shown}
              above={props.above}
              page={page}
            />
          )}
          {pointedAt !== null && (
            <rect
              x={Math.min(plot - 1, Math.round(x(pointed?.at ?? pointedAt)))}
              y={0}
              width={1}
              height={height}
              className={page ? "fill-foreground/40" : "fill-white/40"}
            />
          )}
          {pointed && (
            <circle
              cx={x(pointed.at)}
              cy={y(pointed.value)}
              r={4}
              className={page ? "fill-foreground" : "fill-white"}
            />
          )}
        </svg>
        {pointedAt !== null && (
          <Readout
            x={x(pointed?.at ?? pointedAt)}
            width={plot}
            value={
              pointed
                ? format.text(pointed.value)
                : (props.unknown ?? "Not known")
            }
            about={
              pointed?.at === now
                ? (props.nowText ?? "Now")
                : time(pointed?.at ?? pointedAt)
            }
          />
        )}
      </div>
      {scale?.lines.map((value) => (
        <span
          key={value}
          aria-hidden="true"
          style={{ top: gridYOn(scale, height, value) }}
          className={cn(
            "absolute right-0 -translate-y-1/2 text-[13px] leading-[18px] tabular-nums",
            label,
          )}
        >
          {format.grid(value)}
        </span>
      ))}
      <div
        aria-hidden="true"
        hidden={props.hours === false}
        className="relative mt-2 h-[18px]"
        style={{ width: plot }}
      >
        {ticks.map((at) => (
          <span
            key={at}
            style={{ left: x(at) }}
            className={cn(
              "absolute top-0 -translate-x-1/2 text-[13px] leading-[18px] tabular-nums",
              label,
            )}
          >
            {time(at)}
          </span>
        ))}
      </div>
      <ul className="sr-only">
        {means.map((hour) => (
          <li key={hour.at}>
            {time(hour.at)}: {format.text(hour.value)}
          </li>
        ))}
      </ul>
    </div>
  );
}
