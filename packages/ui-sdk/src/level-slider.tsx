import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

import { usePreview } from "./use-preview";
import { useThrottledSend } from "./use-throttled-send";

const clampLevel = (level: number) =>
  Math.max(0, Math.min(100, Math.round(level)));

/**
 * A level from 0 to 100 as a tall slider, filled from the bottom: a light's
 * brightness, a speaker's volume. It follows a drag at once and sends the
 * level once the drag ends, so a drag is one command; a tap sends where it
 * lands, and keys step it at most every 300 ms. What it was sent shows until
 * the level it is given changes, or a failure puts it back.
 */
export function LevelSlider(props: {
  /** What a screen reader calls it: "Office brightness". */
  label: string;
  level: number;
  /** What fills it up to its level. */
  fill: string;
  /** What a screen reader says of a level: "40%" or "Off". */
  valueText: (level: number) => string;
  disabled?: boolean;
  /** How many commands from it have failed here, so each shows. */
  failures?: number;
  onLevel: (level: number) => void;
  /**
   * What goes around the slider, given the level it shows now, a dragged
   * one included: a light's sun above it and its level below.
   */
  frame?: (slider: ReactNode, shown: number) => ReactNode;
}) {
  const disabled = props.disabled ?? false;
  const preview = usePreview<number>(String(props.level), props.failures);
  const drag = useRef<{ pointerId: number; value: number } | null>(null);
  const [isDragging, setDragging] = useState(false);
  const keys = useThrottledSend(props.onLevel, !disabled);
  const shown = preview.value ?? props.level;

  useEffect(() => {
    if (!disabled) return;
    drag.current = null;
    setDragging(false);
    preview.clear();
  }, [disabled, preview.clear]);

  const at = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return clampLevel(
      (1 - (event.clientY - box.top) / (box.height || 1)) * 100,
    );
  };
  const end = (to: number) => {
    drag.current = null;
    setDragging(false);
    // A previous command may still be in flight even when this matches
    // the reported level, so the final choice must always go out.
    props.onLevel(to);
    preview.hold(to);
  };
  const endAtLastMove = (event: PointerEvent<HTMLDivElement>) => {
    // A release from the browser or its host may arrive before React renders
    // the last move. Use the value tracked by the drag itself.
    const active = drag.current;
    if (active?.pointerId === event.pointerId) end(active.value);
  };

  const slider = (
    <div
      onPointerDown={(event) => {
        // The slider's drags are its own, never the pages' swipes.
        event.stopPropagation();
        if (
          disabled ||
          event.button !== 0 ||
          event.isPrimary === false ||
          drag.current !== null
        )
          return;
        keys.flush();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const value = at(event);
        drag.current = { pointerId: event.pointerId, value };
        setDragging(true);
        preview.drag(value);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (active?.pointerId !== event.pointerId) return;
        active.value = at(event);
        preview.drag(active.value);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) end(at(event));
      }}
      // The slider takes no touch gestures, so a cancel comes from around the
      // page, such as a host app that reports a lifted finger as cancelled:
      // the drag ends where it was.
      onPointerCancel={endAtLastMove}
      onLostPointerCapture={(event) => {
        if (event.target === event.currentTarget) endAtLastMove(event);
      }}
      data-dragging={isDragging ? "" : undefined}
      className="group relative h-72 w-24 overflow-hidden rounded-2xl bg-white/14 [touch-action:none] has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 origin-bottom transition-transform duration-150 group-data-dragging:transition-none motion-reduce:transition-none"
        style={{
          background: props.fill,
          transform: `scaleY(${shown / 100})`,
        }}
      />
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={shown}
        aria-label={props.label}
        aria-valuetext={props.valueText(shown)}
        disabled={disabled}
        onChange={(event) => {
          const level = Number(event.target.value);
          keys.send(level);
          preview.hold(level);
        }}
        onBlur={() => keys.flush()}
        className="sr-only"
      />
    </div>
  );
  return props.frame ? props.frame(slider, shown) : slider;
}
