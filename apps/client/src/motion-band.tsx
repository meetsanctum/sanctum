import type { ReactNode } from "react";

import { midnight, timeText, type Span } from "./device-history-data";

// The motion band: a day of motion 40 px tall, motion as White spans, quiet
// as a hairline along its foot and nothing where nothing was known, with the
// time every 6 hours under or over it. A motion sensor's detail draws one
// for the sensor, Presence's overview one for each room.

export const bandHeight = 40;

const sixHours = 6 * 60 * 60_000;

/**
 * The band's marks, `plot` px wide, `x` placing a time across it. The
 * span pointed at shows in full White; `children` draw over the marks.
 */
export function BandMarks(props: {
  spans: readonly Span[];
  x: (at: number) => number;
  plot: number;
  pointed?: Span;
  children?: ReactNode;
}) {
  const { spans, x, plot } = props;
  return (
    <svg
      aria-hidden="true"
      width={plot}
      height={bandHeight}
      className="block overflow-visible"
    >
      {spans.map((span) => {
        if (!span.known) return null;
        const left = Math.round(x(span.from));
        const right = Math.round(x(span.to));
        if (!span.on) {
          return (
            <rect
              key={span.from}
              x={left}
              y={bandHeight - 1}
              width={Math.max(0, right - left)}
              height={1}
              className="fill-white/30"
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
            className={span === props.pointed ? "fill-white" : "fill-white/70"}
          />
        );
      })}
      {props.children}
    </svg>
  );
}

/**
 * The time every 6 hours of the day, away from the ends, across a band
 * `plot` px wide; with `withNow`, Now at its right end.
 */
export function BandTicks(props: {
  from: number;
  to: number;
  plot: number;
  withNow?: boolean;
  className?: string;
}) {
  const { from, to, plot } = props;
  const x = (at: number) => ((at - from) / (to - from)) * plot;
  // Clear of Now, where it shows.
  const end = props.withNow ? 48 : 20;
  const ticks: number[] = [];
  for (let at = midnight(from); at < to; at += sixHours) {
    const left = x(at);
    if (at > from && left > 20 && left < plot - end) ticks.push(at);
  }
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
          {timeText(at)}
        </span>
      ))}
      {props.withNow && <span className="absolute top-0 right-0">Now</span>}
    </div>
  );
}
