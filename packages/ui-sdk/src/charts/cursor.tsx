import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

// The one cursor every chart has. A mouse's hover shows a readout while it
// is over the chart. A click or a tap pins it, on `click`, which a swipe of
// the pages around the chart swallows, so a drag stays a swipe or a scroll;
// touch never scrubs. Tapping the pinned point again clears it, and so does
// Escape, which a pin takes before the overlay or the shell around the
// chart can. The arrow keys move the pin, Shift by 4 steps, and Home and
// End go to the ends; focus from the keyboard pins the last step, as the
// chart's latest is what a glance wants.
//
// A pin holds what it points at, a time, a span's or a day's, not a place
// along the chart, so it stays put as the minute moves the chart on and the
// data reloads, and clears once that point has left the chart. A hover
// shows over a pin while the mouse is over the chart.

/** What a chart says its points are to its cursor. */
export type CursorPoints<Key> = {
  /** The plot's width in pixels. */
  width: number;
  /** How many steps the arrow keys move through. */
  steps: number;
  /** What a step points at now. */
  keyAt: (step: number) => Key;
  /** The step a point is at now, or null once it has left the chart. */
  stepOf: (key: Key) => number | null;
  /** What a pointer at `x` of `width` px points at. */
  keyAtX: (x: number, width: number) => Key;
  /** A pointer's key as a saved pin, when it differs from the hover key. */
  keyToPin?: (key: Key, step: number) => Key;
};

/**
 * A chart's cursor: what it shows, which is a hover over a pin, and the
 * plot's handlers, which mark it `data-pinned` while it holds a pin.
 */
export function useCursor<Key>(points: CursorPoints<Key>) {
  const { width, steps, keyAt, stepOf, keyAtX, keyToPin } = points;
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [pinState, setPin] = useState<Key | null>(null);
  const pressing = useRef<AbortController | null>(null);
  useEffect(() => () => pressing.current?.abort(), []);

  const pinStep = pinState === null ? null : stepOf(pinState);
  const pin = pinStep === null ? null : pinState;
  if (pin === null && pinState !== null) setPin(null);

  const keyAtPosition = (x: number) =>
    keyAtX(Math.max(0, Math.min(width - 1, x)), width);
  const hover = hoverX === null || width <= 0 ? null : keyAtPosition(hoverX);
  const hoverStep = hover === null ? null : stepOf(hover);
  const shown = hoverStep !== null ? hover : pin;
  const step = hoverStep ?? pinStep;

  const xOf = (event: MouseEvent<HTMLDivElement>) =>
    event.clientX - event.currentTarget.getBoundingClientRect().left;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (pin === null) return;
      // Taken here, so the overlay or shell waits for the next Escape.
      event.preventDefault();
      event.stopPropagation();
      setPin(null);
      return;
    }
    if (steps === 0) return;
    const by = event.shiftKey ? 4 : 1;
    const current = step ?? steps - 1;
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
    setHoverX(null);
    setPin(keyAt(Math.max(0, Math.min(steps - 1, next))));
  };

  return {
    /** What the cursor shows: the hover, or else the pin. */
    shown,
    /** The step of what it shows. */
    step,
    /** What it holds pinned. */
    pin,
    /** The step of the pin. */
    pinStep,
    /** The plot's handlers. */
    plot: {
      "data-pinned": pin === null ? undefined : "",
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (event.pointerType === "mouse") setHoverX(xOf(event));
      },
      onPointerLeave: () => setHoverX(null),
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || event.isPrimary === false) return;
        pressing.current?.abort();
        const press = new AbortController();
        pressing.current = press;
        const plot = event.currentTarget;
        const { ownerDocument } = plot;
        const { pointerId } = event;
        const end = () => {
          press.abort();
          pressing.current = null;
        };
        const options = { capture: true, signal: press.signal };
        // A tap can focus after release, before click. Listen on the
        // document so a release elsewhere or a swipe can end the press too.
        ownerDocument.addEventListener(
          "pointerup",
          (up) => {
            if (up.pointerId !== pointerId) return;
            if (!(up.target instanceof Node) || !plot.contains(up.target))
              end();
          },
          options,
        );
        ownerDocument.addEventListener(
          "pointercancel",
          (cancel) => {
            if (cancel.pointerId === pointerId) end();
          },
          options,
        );
        ownerDocument.addEventListener("click", end, options);
        ownerDocument.addEventListener("keydown", end, options);
      },
      onClick: (event: MouseEvent<HTMLDivElement>) => {
        if (width <= 0) return;
        const x = xOf(event);
        if (hoverX !== null) setHoverX(x);
        const key = keyAtPosition(x);
        const at = stepOf(key);
        setPin(
          at === null || pinStep === at ? null : (keyToPin?.(key, at) ?? key),
        );
      },
      onFocus: () => {
        if (pressing.current || steps === 0) return;
        setPin((current) => current ?? keyAt(steps - 1));
      },
      onBlur: (event: FocusEvent<HTMLDivElement>) => {
        // The window going to the background keeps the pin: the chart
        // still has focus when it comes back.
        if (document.activeElement === event.currentTarget) return;
        setPin(null);
      },
      onKeyDown,
    },
  };
}

/**
 * What a chart's pin points at, said politely to a screen reader as a key
 * or a tap moves it: not as the pin's value changes with a reload or the
 * minute, which nobody asked for, and never for a hover.
 */
export function SpokenPin(props: { pin: unknown; text: string }) {
  const [said, setSaid] = useState({ pin: props.pin, text: props.text });
  if (!Object.is(said.pin, props.pin)) {
    setSaid({ pin: props.pin, text: props.text });
  }
  return (
    <div role="status" className="sr-only">
      {props.pin === null ? "" : said.text}
    </div>
  );
}
