import {
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
  /** How many steps the arrow keys move through. */
  steps: number;
  /** What a step points at now. */
  keyAt: (step: number) => Key;
  /** The step a point is at now, or null once it has left the chart. */
  stepOf: (key: Key) => number | null;
  /** What a pointer at `x` of `width` px points at. */
  keyAtX: (x: number, width: number) => Key;
};

/**
 * A chart's cursor: what it shows, which is a hover over a pin, and the
 * plot's handlers, which mark it `data-pinned` while it holds a pin.
 */
export function useCursor<Key>(points: CursorPoints<Key>) {
  const { steps, keyAt, stepOf, keyAtX } = points;
  const [hover, setHover] = useState<Key | null>(null);
  const [pinState, setPin] = useState<Key | null>(null);
  // Whether a press is under way, whose focus is the pointer's and pins
  // nothing of its own: the click that ends it does. It lasts until that
  // click, since a tap focuses after its finger has lifted.
  const pressing = useRef(false);
  let pin = pinState;
  if (pin !== null && stepOf(pin) === null) {
    pin = null;
    setPin(null);
  }
  const hoverStep = hover === null ? null : stepOf(hover);
  const shown = hoverStep !== null ? hover : pin;
  const step = hoverStep ?? (pin === null ? null : stepOf(pin));

  const xOf = (event: MouseEvent<HTMLDivElement>, width: number) => {
    const box = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(width - 1, event.clientX - box.left));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    pressing.current = false;
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
    setHover(null);
    setPin(keyAt(Math.max(0, Math.min(steps - 1, next))));
  };

  return {
    /** What the cursor shows: the hover, or else the pin. */
    shown,
    /** The step of what it shows. */
    step,
    /** What it holds pinned. */
    pin,
    /** The plot's handlers, for `width` px of it. */
    plot: (width: number) => ({
      "data-pinned": pin === null ? undefined : "",
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (event.pointerType === "mouse")
          setHover(keyAtX(xOf(event, width), width));
      },
      onPointerLeave: () => setHover(null),
      onPointerDown: () => {
        pressing.current = true;
      },
      onPointerCancel: () => {
        pressing.current = false;
      },
      onClick: (event: MouseEvent<HTMLDivElement>) => {
        pressing.current = false;
        const key = keyAtX(xOf(event, width), width);
        const at = stepOf(key);
        setPin(
          at === null || (pin !== null && stepOf(pin) === at) ? null : key,
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
    }),
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
