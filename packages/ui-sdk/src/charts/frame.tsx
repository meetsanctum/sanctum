import { useLayoutEffect, useRef, useState } from "react";

// What every chart is drawn in: its width and the readout over it.

/**
 * The width a chart has, in whole pixels, so its marks sit on them at 1×:
 * the width it's given, or else its box's, measured as it changes.
 */
export function useWidth<Box extends HTMLElement = HTMLDivElement>(
  given?: number,
) {
  const box = useRef<Box>(null);
  const [measured, setMeasured] = useState(0);
  const measures = given === undefined;
  useLayoutEffect(() => {
    const element = box.current;
    if (!measures || !element) return;
    const measure = () => setMeasured(Math.floor(element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measures]);
  return { box, width: measures ? measured : Math.floor(given) };
}

/** A readout over a chart, its value first and what it is about after. */
export function Readout(props: {
  x: number;
  width: number;
  value: string;
  about: string;
  colour?: string;
  inside?: boolean;
}) {
  // Kept within the chart, whatever side of it the pointer is on.
  const left = Math.max(0, Math.min(props.x - 64, props.width - 128));
  return (
    <div
      aria-hidden="true"
      style={props.inside ? besideCursor(props.x, props.width) : { left }}
      className={`pointer-events-none absolute z-10 flex w-32 flex-col rounded-md whitespace-nowrap border border-white/14 bg-(--carbon) px-2.5 py-1.5 text-(--white) ${props.inside ? "top-0 max-w-[calc(50%-1rem)]" : "-top-14"}`}
    >
      <span className="flex items-center gap-1.5 text-[15px] leading-5">
        {props.colour && (
          <span
            className="h-0.5 w-3 shrink-0 rounded-xs"
            style={{ background: props.colour }}
          />
        )}
        {props.value}
      </span>
      <span className="text-[13px] leading-[18px] text-(--silver)">
        {props.about}
      </span>
    </div>
  );
}

function besideCursor(x: number, width: number) {
  return x < width / 2
    ? { left: Math.round(x) + 8 }
    : { right: width - Math.round(x) + 8 };
}

/**
 * A readout over a chart of several lines: what it is about first, then a
 * row for each line, its colour, its name and its value. It sits inside the
 * chart's top, beside the cursor on the side with more room, so a pin that
 * stays covers neither the cursor's points nor what is above the chart.
 * Its Carbon takes Evening's series colours, which are drawn for it.
 */
export function RowsReadout(props: {
  x: number;
  width: number;
  about: string;
  rows: readonly { key: string; name: string; value: string; colour: string }[];
}) {
  return (
    <div
      aria-hidden="true"
      data-mode="evening"
      style={besideCursor(props.x, props.width)}
      className="pointer-events-none absolute top-0 z-10 flex max-w-[min(20rem,calc(50%-1rem))] flex-col gap-0.5 rounded-md whitespace-nowrap border border-white/14 bg-(--carbon) px-2.5 py-1.5 text-(--white)"
    >
      <span className="text-[13px] leading-[18px] text-(--silver)">
        {props.about}
      </span>
      {props.rows.map((row) => (
        <span
          key={row.key}
          className="flex items-center gap-1.5 text-[13px] leading-[18px]"
        >
          <span
            className="h-0.5 w-3 shrink-0 rounded-xs"
            style={{ background: row.colour }}
          />
          <span className="min-w-0 flex-1 truncate text-(--silver)">
            {row.name}
          </span>
          <span className="ms-2 tabular-nums">{row.value}</span>
        </span>
      ))}
    </div>
  );
}

/** The classes of a chart's plot, which takes focus for its cursor. */
export const plotClass =
  "relative rounded-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
