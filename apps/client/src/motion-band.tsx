import type { ReactNode } from "react";

import { sixHours, timeText, type Span } from "./device-history-data";

// The motion band: a day of motion 40 px tall, motion as White spans, quiet
// as a hairline along its foot and nothing where nothing was known, with the
// time every 6 hours under or over it. A motion sensor's detail draws one
// for the sensor, Presence's overview one for each room, and a media
// player's History one for its playing, with the time a player with power
// was on without playing as a faint fill.

export const bandHeight = 40;

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
        if (!span.on && span.powered) {
          // A media player on without playing, faint across the band, and
          // within it however short.
          const fillWidth = Math.max(1, right - left);
          return (
            <rect
              key={span.from}
              x={Math.min(left, plot - fillWidth)}
              y={0}
              width={fillWidth}
              height={bandHeight}
              className={
                span === props.pointed ? "fill-white/24" : "fill-white/16"
              }
            />
          );
        }
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
 * The time every 6 hours of the day, on the clock's own hours whatever the
 * clocks did, away from the ends, across a chart `plot` px wide; with
 * `withNow`, Now at its right end. A light's History has it under its strip.
 */
export function BandTicks(props: {
  from: number;
  to: number;
  plot: number;
  withNow?: boolean;
  className?: string;
}) {
  const { from, to, plot } = props;
  // On whole pixels, so the labels are sharp at 1×.
  const x = (at: number) => Math.round(((at - from) / (to - from)) * plot);
  // Clear of Now, where it shows.
  const end = props.withNow ? 48 : 20;
  const ticks = sixHours(from, to).filter(
    (at) => x(at) > 20 && x(at) < plot - end,
  );
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
