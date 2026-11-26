import { memo } from "react";

import { SpokenPin } from "./cursor";
import { ChartFoot, plotClass, Readout, useWidth } from "./frame";
import { useHomeClock } from "../home-clock";
import { useWeekCursor, WeekNames, weekSlots } from "./week";

// A week as a column a day, as tall as that day's value on a round scale
// whose top shows at the right: hours, such as how long a light was on, or
// counts, such as how often a door opened. It shows a day's value under a
// mouse or where a tap or the arrow keys pin it, and lists the days for
// screen readers.

/**
 * A day of a week's columns, from the start of its day on the home clock:
 * its value, in hours or a count, 0 where it had none, or null where
 * nothing was known of it.
 */
export type WeekColumn = { start: number; value: number | null };

const columnsHeight = 96;
const gutter = 40;

// A week of hours' top: the least of these that holds the longest day.
const hourScales = [1, 2, 4, 6, 8, 12, 16, 24];
// A week of counts' top: the first of these a day's count fits.
const countScales = [5, 10, 20, 50, 100, 200, 500, 1000];

const ColumnMarks = memo(function ColumnMarks(props: {
  days: readonly WeekColumn[];
  slot: number;
  columnWidth: number;
  top: number;
  pointed?: WeekColumn;
  page: boolean;
}) {
  const { slot, columnWidth, page } = props;
  const fill = page ? "fill-foreground/70" : "fill-white/70";
  const pointedFill = page ? "fill-foreground" : "fill-white";
  return props.days.map((day, index) => {
    const value = day.value ?? 0;
    if (value === 0) return null;
    const height = Math.max(2, Math.round((columnsHeight * value) / props.top));
    const left = Math.round(slot * index + (slot - columnWidth) / 2);
    const top = columnsHeight - height;
    const radius = Math.min(4, height);
    return (
      <path
        key={day.start}
        d={`M${left},${columnsHeight}V${top + radius}Q${left},${top} ${left + radius},${top}H${left + columnWidth - radius}Q${left + columnWidth},${top} ${left + columnWidth},${top + radius}V${columnsHeight}Z`}
        className={props.pointed === day ? pointedFill : fill}
      />
    );
  });
});

/** What a week's columns chart takes. */
export type WeekColumnsChartProps<Day extends WeekColumn> = {
  /** The week's days in order, each the caller's own, which `text` and `spoken` get back. */
  days: readonly Day[];
  /** Now, which says which day is today. */
  now: number;
  /** Whether the values are hours or counts, which sets the round values its top can take. */
  scale: "hours" | "counts";
  /** What the chart shows, for a screen reader. */
  label: string;
  /** A day's value, above 0, in its readout. */
  text: (day: Day) => string;
  /** A day's value, above 0, as a screen reader's list says it. */
  spoken: (day: Day) => string;
  /** A known day without any: Off unless said. */
  none?: string;
  /** A day nothing was known of: Not known unless said. */
  unknown?: string;
  /** Today's name under its column: Today unless said. */
  today?: string;
  /** The top's label: 8 h for hours and 20 for counts unless said. */
  topText?: (top: number) => string;
  /** A day's name under its column: Mon unless said. */
  dayName?: (start: number) => string;
  /** A day and its date, in the readout and the list: Mon 3 Nov unless said. */
  date?: (start: number) => string;
  /** Its width in px; without one it measures its box. */
  width?: number;
  /** On a device's glass, in White, or on a page, in its ink. */
  tone?: "glass" | "page";
};

/** The week as a column a day. */
export function WeekColumnsChart<Day extends WeekColumn>(
  props: WeekColumnsChartProps<Day>,
) {
  const clock = useHomeClock();
  const { days, now, text, date = clock.dateText } = props;
  const page = props.tone === "page";
  const labelClass = page ? "text-muted-foreground" : "text-(--pewter)";
  const { box, width } = useWidth(props.width);
  const plot = Math.max(0, width - gutter);
  const cursor = useWeekCursor(days, plot);
  const { slot, markWidth } = weekSlots(plot, days.length);
  const counts = props.scale === "counts";
  const most = Math.max(0, ...days.map((day) => day.value ?? 0));
  const top = counts
    ? (countScales.find((count) => count >= most) ?? most)
    : // The day the clocks go back has 25 hours, which one on all day fills.
      (hourScales.find((hours) => hours >= most) ?? Math.ceil(most));
  const topText =
    props.topText ?? ((shown: number) => (counts ? `${shown}` : `${shown} h`));
  const valueOf = (day: Day) =>
    day.value === null
      ? (props.unknown ?? "Not known")
      : day.value === 0
        ? (props.none ?? "Off")
        : text(day);
  const pointed = cursor.step === null ? undefined : days[cursor.step];
  const pinned = days.find((day) => day.start === cursor.pin);

  return (
    <div ref={box} className="relative">
      <div
        tabIndex={0}
        role="group"
        aria-label={props.label}
        className={plotClass}
        style={{ width: plot, height: columnsHeight }}
        {...cursor.plot}
      >
        <svg
          aria-hidden="true"
          width={plot}
          height={columnsHeight}
          className="block"
        >
          <rect
            x={0}
            y={0}
            width={plot}
            height={1}
            className={page ? "fill-foreground/8" : "fill-white/8"}
          />
          <ChartFoot plot={plot} height={columnsHeight} page={page} />
          {plot > 0 && (
            <ColumnMarks
              days={days}
              slot={slot}
              columnWidth={markWidth}
              top={top}
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
      <span
        aria-hidden="true"
        className={`absolute top-0 right-0 -translate-y-1/2 text-[13px] leading-[18px] tabular-nums ${labelClass}`}
      >
        {topText(top)}
      </span>
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
            {date(day.start)}:{" "}
            {(day.value ?? 0) === 0 ? valueOf(day) : props.spoken(day)}
          </li>
        ))}
      </ul>
    </div>
  );
}
