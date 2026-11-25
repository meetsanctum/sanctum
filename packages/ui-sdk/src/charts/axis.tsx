import { useWidth } from "./frame";
import { useHomeClock } from "../home-clock";

/**
 * The time every 6 hours of the day, on the clock's own hours whatever the
 * clocks did, away from the ends, across a chart `plot` px wide; with
 * `withNow`, Now at its right end.
 */
export function TimeTicks(props: {
  from: number;
  to: number;
  plot: number;
  withNow?: boolean;
  fractional?: boolean;
  className?: string;
  time?: (at: number) => string;
  nowText?: string;
}) {
  const clock = useHomeClock();
  const { from, to, plot, time = clock.hourText } = props;
  // On whole pixels by default, so the labels are sharp at 1×.
  const x = (at: number) => {
    const left = ((at - from) / (to - from)) * plot;
    return props.fractional ? left : Math.round(left);
  };
  // Clear of Now, where it shows.
  const end = props.withNow ? 48 : 20;
  const ticks = clock
    .hours(from, to)
    .filter((at) => x(at) > 20 && x(at) < plot - end);
  return (
    <div
      aria-hidden="true"
      className={`relative h-[18px] text-[13px] leading-[18px] tabular-nums ${props.className ?? ""}`}
      style={{ width: plot }}
    >
      {ticks.map((at) => (
        <span
          key={at}
          style={{ left: x(at) }}
          className="absolute top-0 -translate-x-1/2"
        >
          {time(at)}
        </span>
      ))}
      {props.withNow && (
        <span className="absolute top-0 right-0">{props.nowText ?? "Now"}</span>
      )}
    </div>
  );
}

/** What a day's time axis takes. */
export type DayTimeAxisProps = {
  /** When the day starts and ends, in ms since the epoch. */
  from: number;
  to: number;
  /** Whether it ends with Now at the right. */
  withNow?: boolean;
  /** Its width in px; without one it measures its box. */
  width?: number;
  /** Its labels' colour, as classes. */
  className?: string;
  /** An hour as a label says it: as the home writes it, 06:00 or 6 AM, unless said. */
  time?: (at: number) => string;
  /** What its right end says with `withNow`: Now unless said. */
  nowText?: string;
};

/**
 * A day's hours on their own, every 6 on the clock's own hours, for charts
 * that share one axis, such as a band in each of a list's rows.
 */
export function DayTimeAxis(props: DayTimeAxisProps) {
  const { box, width } = useWidth(props.width);
  return (
    <div ref={box}>
      <TimeTicks
        from={props.from}
        to={props.to}
        plot={width}
        withNow={props.withNow}
        className={props.className}
        time={props.time}
        nowText={props.nowText}
      />
    </div>
  );
}
