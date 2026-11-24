import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

// What every chart is drawn in: its width, the cursor a pointer or the arrow
// keys move along it, and the readout over it.

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
}) {
  // Kept within the chart, whatever side of it the pointer is on.
  const left = Math.max(0, Math.min(props.x - 64, props.width - 128));
  return (
    <div
      aria-hidden="true"
      style={{ left }}
      className="pointer-events-none absolute -top-14 z-10 flex w-32 flex-col rounded-md whitespace-nowrap border border-white/14 bg-(--carbon) px-2.5 py-1.5 text-(--white)"
    >
      <span className="flex items-center gap-1.5 text-[15px] leading-5">
        {props.colour && (
          <span
            className="h-0.5 w-3 shrink-0 rounded-full"
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

// Where a pointer or the arrow keys point along a chart, in its own steps.
export function useCursor(
  steps: number,
  // Which step a pointer at x falls on, where the steps aren't all as wide.
  stepAt?: (x: number, width: number) => number,
) {
  const [selected, setAt] = useState<number | null>(null);
  // Keep the cursor at the new end when a chart loses steps.
  let at = selected;
  if (at !== null && at >= steps) {
    at = steps - 1;
    setAt(at);
  }
  const fromPointer =
    (width: number) => (event: PointerEvent<HTMLDivElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const x = Math.max(0, Math.min(width - 1, event.clientX - box.left));
      setAt(
        Math.min(
          steps - 1,
          stepAt ? stepAt(x, width) : Math.floor((x / width) * steps),
        ),
      );
    };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.shiftKey ? 4 : 1;
    const current = at ?? steps - 1;
    const next =
      event.key === "ArrowLeft"
        ? current - by
        : event.key === "ArrowRight"
          ? current + by
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? steps - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    setAt(Math.max(0, Math.min(steps - 1, next)));
  };
  return {
    at,
    handlers: (width: number) => ({
      onPointerMove: fromPointer(width),
      onPointerDown: fromPointer(width),
      onPointerLeave: () => setAt(null),
      onFocus: () => setAt((current) => current ?? steps - 1),
      onBlur: () => setAt(null),
      onKeyDown,
    }),
  };
}

/** The classes of a chart's plot, which takes focus for its cursor. */
export const plotClass =
  "relative rounded-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
