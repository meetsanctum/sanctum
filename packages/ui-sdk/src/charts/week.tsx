import { midnight, weekdayText } from "./time";

// What a week's charts share: a slot a day across the plot, a mark up to 24
// px wide in the middle of each, and the days' names under them, today's as
// Today.

/** How wide each day's slot and its mark are, across `plot` px. */
export function weekSlots(plot: number, days: number) {
  const slot = plot / Math.max(1, days);
  return { slot, markWidth: Math.max(4, Math.min(24, Math.floor(slot - 8))) };
}

/** The days' names under a week's chart. */
export function WeekNames(props: {
  days: readonly { start: number }[];
  now: number;
  plot: number;
  slot: number;
  labelClass: string;
  today?: string;
  dayName?: (start: number) => string;
}) {
  const { days, plot, slot, dayName = weekdayText } = props;
  const today = midnight(props.now);
  return (
    <div
      aria-hidden="true"
      className="relative mt-2 h-[18px]"
      style={{ width: plot }}
    >
      {days.map((day, index) => (
        <span
          key={day.start}
          style={{ left: Math.round(slot * (index + 0.5)) }}
          className={`absolute top-0 -translate-x-1/2 text-[13px] leading-[18px] ${props.labelClass}`}
        >
          {day.start === today ? (props.today ?? "Today") : dayName(day.start)}
        </span>
      ))}
    </div>
  );
}
