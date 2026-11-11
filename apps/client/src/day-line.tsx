import { cn } from "cn";
import { useId } from "react";

import { Readout, useCursor, useWidth } from "./device-history";
import { dayMs, midnight, timeText } from "./device-history-data";
import { hourlyMeans, scaleOf, type DayLine } from "./sensor-history-data";

// A day as a line through each 5 minutes' mean: a sensor's reading in its
// detail, and the machine's processor, temperature and memory on Settings →
// Status. It is broken where nothing was known, has two or three faint
// gridlines with their values at the right and the hours every 6 below, and
// shows its value under the pointer or, with the arrow keys, under a cursor;
// screen readers get each hour's mean as a list. On a device's detail it is
// drawn on glass; on a page, in the page's ink.

const slots = 24 * 12;
const slotMs = dayMs / slots;

/** How a chart shows its values: in the unit shown, its gridlines' labels, and the gutter they take. */
export type ChartFormat = {
  gutter: number;
  shown: (value: number) => number;
  text: (value: number) => string;
  grid: (shownValue: number) => string;
};

/** The local hours every 6 within the day, whatever the clocks did. */
export function sixHours(from: number, now: number) {
  const start = midnight(from);
  const hours: number[] = [];
  for (let hour = 0; ; hour += 6) {
    const date = new Date(start);
    date.setHours(hour);
    const at = date.getTime();
    if (at >= now) return hours;
    if (at > from) hours.push(at);
  }
}

export function DayLineChart(props: {
  line: DayLine;
  now: number;
  format: ChartFormat;
  name: string;
  height: number;
  // Fixed bounds where they mean something, in the unit shown; otherwise
  // round ones around what it read.
  scale?: { min: number; max: number; lines: number[] };
  // Past this value, in the unit shown, the line turns the danger colour.
  above?: number;
  tone?: "glass" | "page";
  // The hours under it; charts stacked on one time axis show them once.
  hours?: boolean;
}) {
  const { line, now, format, height } = props;
  const page = props.tone === "page";
  const clip = useId();
  const { box, width } = useWidth();
  const points = line.runs.flat();
  // What it reads now, where the line ends: a step of its own after the
  // day's 5 minutes, so the last of them stays within the cursor's reach.
  const live = points.find((each) => each.at === now);
  const kept = live ? points.filter((each) => each !== live) : points;
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
  const shown = points.map((each) => format.shown(each.value));
  const scale =
    props.scale ??
    (shown.length > 0 ? scaleOf(Math.min(...shown), Math.max(...shown)) : null);
  const x = (at: number) => ((at - from) / dayMs) * plot;
  const yOfShown = (shownValue: number) =>
    scale
      ? height -
        ((Math.min(scale.max, Math.max(scale.min, shownValue)) - scale.min) /
          (scale.max - scale.min)) *
          height
      : height / 2;
  const y = (value: number) => yOfShown(format.shown(value));
  const gridY = (shownValue: number) => Math.round(yOfShown(shownValue)) + 0.5;
  const ticks = sixHours(from, now).filter(
    (at) => x(at) > 20 && x(at) < plot - 20,
  );
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
  const stroke = page ? "stroke-foreground/85" : "stroke-white/85";
  const label = page ? "text-muted-foreground" : "text-(--pewter)";
  const runs = line.runs.map((run) =>
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
    <div ref={box} className="relative">
      <div
        tabIndex={0}
        role="group"
        aria-label={`${props.name} over the last 24 hours`}
        className="relative rounded-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        style={{ width: plot, height }}
        {...cursor.handlers(plot)}
      >
        <svg
          aria-hidden="true"
          width={plot}
          height={height}
          className="block overflow-visible"
        >
          {scale?.lines.map((value) => (
            <rect
              key={value}
              x={0}
              y={gridY(value) - 0.5}
              width={plot}
              height={1}
              className={page ? "fill-foreground/12" : "fill-white/12"}
            />
          ))}
          <g
            className={cn(
              stroke,
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
            value={pointed ? format.text(pointed.value) : "Not known"}
            about={
              pointed?.at === now ? "Now" : timeText(pointed?.at ?? pointedAt)
            }
          />
        )}
      </div>
      {scale?.lines.map((value) => (
        <span
          key={value}
          aria-hidden="true"
          style={{ top: gridY(value) }}
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
            {timeText(at)}
          </span>
        ))}
      </div>
      <ul className="sr-only">
        {hourlyMeans(line).map((hour) => (
          <li key={hour.at}>
            {timeText(hour.at)}: {format.text(hour.value)}
          </li>
        ))}
      </ul>
    </div>
  );
}
