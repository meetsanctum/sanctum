import { cn } from "cn";
import { memo, useId, useMemo } from "react";

import { TimeTicks } from "./axis";
import { SpokenPin, useCursor } from "./cursor";
import { DaysLineChart, type DaysLineChartProps } from "./days-line";
import { plotClass, Readout, useWidth } from "./frame";
import { LineGridLabels, LineGridMarks } from "./line-grid";
import { scaleOf, yOn, type ChartScale } from "./scale";
import { useHomeClock } from "../home-clock";
import { dayMs, hourMs } from "./time";

// A day as a line through each 5 minutes' mean, such as a sensor's reading.
// It is broken where nothing was known, has two or three faint gridlines with
// their values at the right, a hairline along its foot and the hours every 6
// below, and shows its value under a mouse or where a tap or the arrow keys
// pin it; screen readers get each hour's mean as a list. On glass it is drawn
// in White; on a page, in the page's ink.

const slots = 24 * 12;
const slotMs = dayMs / slots;
// What the cursor holds at Now, which moves on with the chart.
const atNow = Number.POSITIVE_INFINITY;

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
  const runs = props.runs.map((run) => {
    const first = run[0];
    if (!first) return null;
    return run.length === 1 ? (
      <circle key={first.at} cx={x(first.at)} cy={y(first.value)} r={1.5} />
    ) : (
      <polyline
        key={first.at}
        fill="none"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={run.map((each) => `${x(each.at)},${y(each.value)}`).join(" ")}
      />
    );
  });
  return (
    <>
      <LineGridMarks scale={scale} height={height} page={page} plot={plot} />
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

// The nearest reading within [at - half a slot, at + half a slot).
function nearest(points: readonly LinePoint[], at: number) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid]!.at < at) low = mid + 1;
    else high = mid;
  }
  const half = slotMs / 2;
  const before = points[low - 1];
  const after = points[low];
  if (
    before &&
    at - before.at <= half &&
    (!after || at - before.at <= after.at - at)
  ) {
    return before;
  }
  return after && after.at - at < half ? after : undefined;
}

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
  /** A time of day as the chart says it: as the home writes it, 07:30 or 7:30 AM, unless said. */
  time?: (at: number) => string;
  /** Its width in px; without one it measures its box. */
  width?: number;
};

export type DayLineChartProps = LineChartProps;

type LineChartInput = (LineChartProps & { mode?: never }) | DaysLineChartProps;

/** A day as a line, or days as lines, with their gridlines, times and a cursor. */
export function LineChart(props: LineChartInput) {
  return props.mode === "days" ? (
    <DaysLineChart {...props} />
  ) : (
    <DayLineChart {...props} />
  );
}

// A day as a line, with its gridlines, hours and a cursor.
function DayLineChart(props: LineChartProps) {
  const clock = useHomeClock();
  const { runs, now, format, height, time = clock.timeText } = props;
  const page = props.tone === "page";
  const { box, width } = useWidth(props.width);
  const points = useMemo(() => runs.flat(), [runs]);
  // What it reads now, where the line ends: a step of its own after the
  // day's 5 minutes, so the last of them stays within the cursor's reach.
  const live = useMemo(
    () => points.find((each) => each.at === now),
    [points, now],
  );
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
  const steps = slots + (live ? 1 : 0);
  // A step points at its reading, or its 5 minutes' middle without one, and
  // the last, after the day's, at Now, whatever time it is.
  const keyAt = (step: number) => {
    if (live && step === slots) return atNow;
    const middle = from + (step + 0.5) * slotMs;
    return nearest(kept, middle)?.at ?? middle;
  };
  const cursor = useCursor<number>({
    width: plot,
    steps,
    keyAt,
    stepOf: (key) =>
      key === atNow
        ? live
          ? slots
          : null
        : key < from || key > now
          ? null
          : Math.min(slots - 1, Math.floor((key - from) / slotMs)),
    keyAtX: (pointerX, wide) => {
      const nearer = ((nowFrom - from) / dayMs) * wide;
      if (live && pointerX >= Math.min(nearer, wide - 1)) return atNow;
      return keyAt(Math.min(slots - 1, Math.floor((pointerX / wide) * slots)));
    },
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
  const pointedAt =
    cursor.shown === null ? null : cursor.shown === atNow ? now : cursor.shown;
  // The reading the cursor is on, or at Now what it reads now.
  const readingAt = (key: number | null) =>
    key === null ? undefined : key === atNow ? live : nearest(kept, key);
  const pointed = readingAt(cursor.shown);
  // What a reading or a time is, in the readout and to a screen reader.
  const valueOf = (reading: LinePoint | undefined) =>
    reading ? format.text(reading.value) : (props.unknown ?? "Not known");
  const aboutOf = (reading: LinePoint | undefined, at: number) =>
    reading?.at === now ? (props.nowText ?? "Now") : time(reading?.at ?? at);
  const pinnedAt =
    cursor.pin === null ? null : cursor.pin === atNow ? now : cursor.pin;
  const pinned = cursor.pin === cursor.shown ? pointed : readingAt(cursor.pin);
  const label = page ? "text-muted-foreground" : "text-(--pewter)";

  return (
    <div ref={box} className="relative">
      <div
        tabIndex={0}
        role="group"
        aria-label={props.label ?? `${props.name} over the last 24 hours`}
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
            value={valueOf(pointed)}
            about={aboutOf(pointed, pointedAt)}
          />
        )}
      </div>
      <LineGridLabels
        scale={scale}
        height={height}
        page={page}
        format={format}
      />
      {props.hours !== false && (
        <TimeTicks
          from={from}
          to={now}
          plot={plot}
          time={props.time}
          fractional
          className={`mt-2 ${label}`}
        />
      )}
      <SpokenPin
        pin={cursor.pin}
        text={
          pinnedAt === null
            ? ""
            : `${aboutOf(pinned, pinnedAt)}: ${valueOf(pinned)}`
        }
      />
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
