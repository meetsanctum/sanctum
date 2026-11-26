import { memo, useMemo } from "react";

import { SpokenPin } from "./cursor";
import { ChartFoot, plotClass, Readout, useWidth } from "./frame";
import type { ChartFormat } from "./line";
import { scaleFraction, scaleOf, type ChartScale } from "./scale";
import { useHomeClock } from "../home-clock";
import { useWeekCursor, WeekNames, weekSlots } from "./week";

// A week as a bar a day from its lowest to its highest, such as a sensor's
// readings, on round gridlines with their values at the right, over a
// hairline along its foot. It shows a day's range under a mouse or where a
// tap or the arrow keys pin it, and lists the days for screen readers.

/** A day of a week's ranges, from the start of its day on the home clock: its lowest and highest, or none when nothing was known. */
export type WeekRange =
  | { start: number; min: number; max: number }
  | { start: number; min: null; max: null };

/** How a week's ranges show their values: as a day's line does, with a range in words. */
export type WeekRangeFormat = Pick<ChartFormat, "gutter" | "shown" | "grid"> & {
  range: (min: number, max: number) => string;
};

const barsHeight = 96;

// Where a value in the unit shown sits, from the top.
const yOn = (scale: ChartScale | null, shownValue: number) =>
  scale ? barsHeight - scaleFraction(scale, shownValue) * barsHeight : 0;

const RangeMarks = memo(function RangeMarks(props: {
  days: readonly WeekRange[];
  plot: number;
  slot: number;
  barWidth: number;
  scale: ChartScale | null;
  shown: (value: number) => number;
  pointed?: WeekRange;
  page: boolean;
}) {
  const { plot, slot, barWidth, scale, shown, page } = props;
  const fill = page ? "fill-foreground/70" : "fill-white/70";
  const pointedFill = page ? "fill-foreground" : "fill-white";
  return (
    <>
      {scale?.lines.map((value) => (
        <rect
          key={value}
          x={0}
          y={Math.round(yOn(scale, value))}
          width={plot}
          height={1}
          className={page ? "fill-foreground/12" : "fill-white/12"}
        />
      ))}
      {props.days.map((day, index) => {
        if (day.min === null) return null;
        const top = Math.round(yOn(scale, shown(day.max)));
        const height = Math.max(
          4,
          Math.round(yOn(scale, shown(day.min))) - top,
        );
        const left = Math.round(slot * index + (slot - barWidth) / 2);
        return (
          <rect
            key={day.start}
            x={left}
            y={top}
            width={barWidth}
            height={height}
            rx={4}
            className={props.pointed === day ? pointedFill : fill}
          />
        );
      })}
    </>
  );
});

/** What a week's range chart takes. */
export type WeekRangeChartProps = {
  /** The week's days in order. */
  days: readonly WeekRange[];
  /** Now, which says which day is today. */
  now: number;
  format: WeekRangeFormat;
  /** What it charts, as its label says it: Temperature. */
  name: string;
  /** What it is, for a screen reader: each day's lowest and highest of its name unless said. */
  label?: string;
  /** A day nothing was known of: Not known unless said. */
  unknown?: string;
  /** Today's name under its bar: Today unless said. */
  today?: string;
  /** A day's name under its bar: Mon unless said. */
  dayName?: (start: number) => string;
  /** A day and its date, in the readout and the list: Mon 3 Nov unless said. */
  date?: (start: number) => string;
  /** Its width in px; without one it measures its box. */
  width?: number;
  /** On a device's glass, in White, or on a page, in its ink. */
  tone?: "glass" | "page";
};

/** Each day of the week as a bar from its lowest to its highest. */
export function WeekRangeChart(props: WeekRangeChartProps) {
  const clock = useHomeClock();
  const { days, now, format, date = clock.dateText } = props;
  const page = props.tone === "page";
  const labelClass = page ? "text-muted-foreground" : "text-(--pewter)";
  const { box, width } = useWidth(props.width);
  const plot = Math.max(0, width - format.gutter);
  const cursor = useWeekCursor(days, plot);
  const { slot, markWidth: barWidth } = weekSlots(plot, days.length);
  const scale = useMemo(() => {
    const shown = days.flatMap((day) =>
      day.min === null ? [] : [format.shown(day.min), format.shown(day.max)],
    );
    return shown.length > 0
      ? scaleOf(Math.min(...shown), Math.max(...shown))
      : null;
  }, [days, format]);
  const valueOf = (day: WeekRange) =>
    day.min === null
      ? (props.unknown ?? "Not known")
      : format.range(day.min, day.max);
  const pointed = cursor.step === null ? undefined : days[cursor.step];
  const pinned = days.find((day) => day.start === cursor.pin);

  return (
    <div ref={box} className="relative">
      <div
        tabIndex={0}
        role="group"
        aria-label={
          props.label ??
          `Each day's lowest and highest ${props.name.toLowerCase()}`
        }
        className={plotClass}
        style={{ width: plot, height: barsHeight }}
        {...cursor.plot}
      >
        <svg
          aria-hidden="true"
          width={plot}
          height={barsHeight}
          className="block"
        >
          <ChartFoot plot={plot} height={barsHeight} page={page} />
          {plot > 0 && (
            <RangeMarks
              days={days}
              plot={plot}
              slot={slot}
              barWidth={barWidth}
              scale={scale}
              shown={format.shown}
              pointed={pointed}
              page={page}
            />
          )}
        </svg>
        {pointed && (
          <Readout
            x={Math.round(slot * (cursor.step! + 0.5))}
            width={plot}
            value={valueOf(pointed)}
            about={date(pointed.start)}
          />
        )}
      </div>
      {scale?.lines.map((value) => (
        <span
          key={value}
          aria-hidden="true"
          style={{ top: Math.round(yOn(scale, value)) }}
          className={`absolute right-0 -translate-y-1/2 text-[13px] leading-[18px] tabular-nums ${labelClass}`}
        >
          {format.grid(value)}
        </span>
      ))}
      <WeekNames
        days={days}
        now={now}
        plot={plot}
        slot={slot}
        labelClass={labelClass}
        today={props.today}
        dayName={props.dayName}
      />
      <SpokenPin
        pin={cursor.pin}
        text={pinned ? `${date(pinned.start)}: ${valueOf(pinned)}` : ""}
      />
      <ul className="sr-only">
        {days.map((day) => (
          <li key={day.start}>
            {date(day.start)}: {valueOf(day)}
          </li>
        ))}
      </ul>
    </div>
  );
}
