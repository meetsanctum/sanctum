import { memo, useMemo } from "react";

import { SpokenPin, useCursor } from "./cursor";
import { plotClass, Readout, RowsReadout, useWidth } from "./frame";
import type { ChartFormat } from "./line";
import { gridYOn, scaleOf, yOn, type ChartScale } from "./scale";
import { dateText } from "./time";

// Days as lines, a point a day, such as each model's tokens over the last
// 30: up to three, in the theme's series colours in their order, broken
// where a day wasn't known. It has two or three faint gridlines with their
// values at the right and, under it, its first day, its middle one and
// Today, and shows each line's value under a mouse or where a tap or the
// arrow keys pin it, a day at a time; screen readers get each day as a list.

/** One of a chart's lines over days: its value each day, in the days' order, or null where it wasn't known. */
export type LineSeries = {
  key: string;
  /** What it is, in the readout and the list: Office Mac. */
  name: string;
  values: readonly (number | null)[];
};

/** What a line chart over days takes. */
export type DaysLineChartProps = {
  /** Each day's start, oldest first and today last. */
  days: readonly number[];
  /** Its lines, up to three, in the order of their colours. */
  series: readonly LineSeries[];
  format: ChartFormat;
  /** What it charts, as its label says it: Tokens used. */
  name: string;
  height: number;
  /** Fixed bounds where they mean something, in the unit shown; otherwise round ones around its values. */
  scale?: ChartScale;
  /** What it is, for a screen reader: its name over the days unless said. */
  label?: string;
  /** A day nothing was known of: Not known unless said. */
  unknown?: string;
  /** The last day's name under the chart and in its readout: Today unless said. */
  today?: string;
  /** A day as the chart says it: Mon 3 Nov unless said. */
  date?: (start: number) => string;
  /** Its width in px; without one it measures its box. */
  width?: number;
  /** On a device's glass, in White, or on a page, in its ink. */
  tone?: "glass" | "page";
};

/** A line's colour, by its place among the chart's lines. */
export const seriesColour = (index: number) =>
  `var(--series-${(index % 3) + 1})`;

// The lines and gridlines, apart from the cursor, which a pointer moves
// without drawing them again.
const DaysMarks = memo(function DaysMarks(props: {
  series: readonly LineSeries[];
  xs: readonly number[];
  height: number;
  scale: ChartScale | null;
  shown: (value: number) => number;
  plot: number;
  page: boolean;
}) {
  const { xs, height, scale, shown, plot } = props;
  const y = (value: number) => yOn(scale, height, shown(value));
  return (
    <>
      {scale?.lines.map((value) => (
        <rect
          key={value}
          x={0}
          y={gridYOn(scale, height, value) - 0.5}
          width={plot}
          height={1}
          className={props.page ? "fill-foreground/12" : "fill-white/12"}
        />
      ))}
      {props.series.map((line, index) => {
        // Each run of known days, broken where one wasn't.
        const runs: { day: number; value: number }[][] = [[]];
        line.values.forEach((value, day) => {
          if (value === null) runs.push([]);
          else runs.at(-1)!.push({ day, value });
        });
        const colour = seriesColour(index);
        return (
          <g key={line.key} style={{ stroke: colour, fill: colour }}>
            {runs.map((run) => {
              const first = run[0];
              if (!first) return null;
              return run.length === 1 ? (
                <circle
                  key={first.day}
                  cx={xs[first.day]}
                  cy={y(first.value)}
                  r={1.5}
                  stroke="none"
                />
              ) : (
                <polyline
                  key={first.day}
                  fill="none"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={run
                    .map((each) => `${xs[each.day]},${y(each.value)}`)
                    .join(" ")}
                />
              );
            })}
          </g>
        );
      })}
    </>
  );
});

/** Days as lines, a point a day, with their gridlines, three days named under them and a cursor. */
export function DaysLineChart(props: DaysLineChartProps) {
  const { days, series, format, height, date = dateText } = props;
  const page = props.tone === "page";
  const { box, width } = useWidth(props.width);
  const plot = Math.max(0, width - format.gutter);
  const last = days.length - 1;
  // Each day's place, a pixel's middle so the line, its dots and the
  // cursor are sharp at 1×, the first at the left edge and today at the
  // right.
  const xs = useMemo(
    () =>
      days.map(
        (_, index) =>
          (last > 0
            ? Math.round((index / last) * (plot - 1))
            : Math.floor(plot / 2)) + 0.5,
      ),
    [days, last, plot],
  );
  const dayText = (start: number) =>
    start === days[last] ? (props.today ?? "Today") : date(start);
  const cursor = useCursor<number>({
    width: plot,
    steps: days.length,
    keyAt: (step) => days[step] ?? Number.NaN,
    stepOf: (start) => {
      const step = days.indexOf(start);
      return step < 0 ? null : step;
    },
    keyAtX: (pointerX, wide) =>
      days[
        last > 0 ? Math.round((pointerX / Math.max(1, wide - 1)) * last) : 0
      ] ?? Number.NaN,
  });
  const given = props.scale;
  const scale = useMemo(() => {
    if (given) return given;
    const shown = series.flatMap((line) =>
      line.values.flatMap((value) =>
        value === null ? [] : [format.shown(value)],
      ),
    );
    return shown.length > 0
      ? scaleOf(Math.min(...shown), Math.max(...shown))
      : null;
  }, [given, series, format]);
  const y = (value: number) => yOn(scale, height, format.shown(value));
  const valueText = (value: number | null | undefined) =>
    value === null || value === undefined
      ? (props.unknown ?? "Not known")
      : format.text(value);
  const rowsOf = (step: number) =>
    series.map((line, index) => ({
      key: line.key,
      name: line.name,
      value: valueText(line.values[step]),
      colour: seriesColour(index),
    }));
  const saidOf = (step: number) =>
    `${dayText(days[step]!)}: ${series
      .map((line) =>
        series.length > 1
          ? `${line.name} ${valueText(line.values[step])}`
          : valueText(line.values[step]),
      )
      .join(", ")}`;
  const step = cursor.step;
  const label = page ? "text-muted-foreground" : "text-(--pewter)";
  const middle = Math.floor(last / 2);

  return (
    <div ref={box} className="relative">
      <div
        tabIndex={0}
        role="group"
        aria-label={props.label ?? `${props.name} each day`}
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
            <DaysMarks
              series={series}
              xs={xs}
              height={height}
              scale={scale}
              shown={format.shown}
              plot={plot}
              page={page}
            />
          )}
          {step !== null && (
            <>
              <rect
                x={xs[step]! - 0.5}
                y={0}
                width={1}
                height={height}
                className={page ? "fill-foreground/40" : "fill-white/40"}
              />
              {series.map((line, index) => {
                const value = line.values[step];
                return value === null || value === undefined ? null : (
                  <circle
                    key={line.key}
                    cx={xs[step]}
                    cy={y(value)}
                    r={4}
                    style={{ fill: seriesColour(index) }}
                  />
                );
              })}
            </>
          )}
        </svg>
        {step !== null &&
          (series.length > 1 ? (
            <RowsReadout
              x={xs[step]!}
              width={plot}
              about={dayText(days[step]!)}
              rows={rowsOf(step)}
            />
          ) : (
            <Readout
              x={xs[step]!}
              width={plot}
              value={valueText(series[0]?.values[step])}
              about={dayText(days[step]!)}
            />
          ))}
      </div>
      {scale?.lines.map((value) => (
        <span
          key={value}
          aria-hidden="true"
          style={{ top: gridYOn(scale, height, value) }}
          className={`absolute right-0 -translate-y-1/2 text-[13px] leading-[18px] tabular-nums ${label}`}
        >
          {format.grid(value)}
        </span>
      ))}
      <div
        aria-hidden="true"
        className={`relative mt-2 h-[18px] text-[13px] leading-[18px] ${label}`}
        style={{ width: plot }}
      >
        {last > 0 && (
          <span className="absolute top-0 left-0">{dayText(days[0]!)}</span>
        )}
        {last > 1 && (
          <span
            className="absolute top-0 -translate-x-1/2"
            style={{ left: xs[middle] }}
          >
            {dayText(days[middle]!)}
          </span>
        )}
        {last >= 0 && (
          <span className="absolute top-0 right-0">{dayText(days[last]!)}</span>
        )}
      </div>
      <SpokenPin
        pin={cursor.pin}
        text={cursor.pinStep === null ? "" : saidOf(cursor.pinStep)}
      />
      <ul className="sr-only">
        {days.map((start, index) => (
          <li key={start}>{saidOf(index)}</li>
        ))}
      </ul>
    </div>
  );
}
