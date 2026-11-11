import type {
  LightCommand,
  LightFeatures,
  LightState,
} from "@meetsanctum/app-sdk";
import { Palette, Power, Sun, SunDim, Thermometer } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { LightPicker } from "./light-picker";
import { showFailed } from "./show-failed";
import { SwipePages, type SwipePage } from "./swipe-pages";
import { lightColour } from "./tiles";
import { usePreview } from "./use-preview";
import { useThrottledSend } from "./use-throttled-send";

// A light's controls, as its detail shows them: pages for its colour or
// white and for its brightness, each only where the light has it, swiped
// between or chosen from their tabs; a light with neither gets a power
// button, and so does a switch, given no features. They draw the state they
// are given and say what to ask for, so the shell sends it to the light and
// a mood's editor can keep it in its draft. Pages of the shell's own, such
// as the light's history, follow theirs. A command that fails shakes them
// and drops what a drag or key was showing.

export function LightControls(props: {
  name: string;
  features: LightFeatures;
  state: LightState;
  /** Offline: shown, with nothing to press. */
  disabled?: boolean;
  /** How many commands to the light have failed here, so each shows. */
  failures?: number;
  onCommand: (command: LightCommand) => void;
  /** Pages after the controls', such as the shell's History. */
  pages?: readonly SwipePage[];
}) {
  const { name, features, state, failures } = props;
  const disabled = props.disabled ?? false;
  const box = useRef<HTMLDivElement>(null);
  const seen = useRef(failures ?? 0);
  useEffect(() => {
    if ((failures ?? 0) <= seen.current) return;
    seen.current = failures ?? 0;
    showFailed(box.current, null);
  }, [failures]);

  const pages: SwipePage[] = [];
  if (features.color || features.colorTemperature) {
    pages.push({
      id: "colour",
      label: features.color ? "Colour" : "White",
      icon: features.color ? Palette : Thermometer,
      content: (
        <LightPicker
          name={name}
          features={features}
          state={state}
          disabled={disabled}
          failures={failures}
          onCommand={props.onCommand}
        />
      ),
    });
  }
  if (features.brightness) {
    pages.push({
      id: "brightness",
      label: "Brightness",
      icon: Sun,
      content: (
        <BrightnessSlider
          name={name}
          state={state}
          disabled={disabled}
          failures={failures}
          onBrightness={(brightness) => props.onCommand({ brightness })}
        />
      ),
    });
  }
  if (pages.length === 0) {
    pages.push({
      id: "power",
      label: "Power",
      icon: Power,
      content: (
        <PowerButton
          name={name}
          on={state.on}
          disabled={disabled}
          onToggle={() => props.onCommand({ on: !state.on })}
        />
      ),
    });
  }
  // An offline light's own pages show its state faded, with nothing to
  // press; the shell's pages are as they are.
  for (const page of pages) page.muted = disabled;
  pages.push(...(props.pages ?? []));

  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      <SwipePages label={name} pages={pages} />
    </div>
  );
}

/** A switch, or a light with nothing more to set: one big round button. */
export function PowerButton(props: {
  name: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const on = props.on && !props.disabled;
  return (
    <div className="flex flex-col items-center gap-4">
      <button
        type="button"
        aria-label={props.name}
        aria-pressed={on}
        disabled={props.disabled}
        onClick={props.onToggle}
        className="grid size-28 place-items-center rounded-full bg-white/14 text-white outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:bg-white aria-pressed:text-(--carbon)"
      >
        <Power aria-hidden="true" className="size-11" strokeWidth={1.6} />
      </button>
      <span className="text-[13px] leading-[18px] font-medium text-(--silver)">
        {props.disabled ? "Offline" : on ? "On" : "Off"}
      </span>
    </div>
  );
}

const clampLevel = (level: number) =>
  Math.max(0, Math.min(100, Math.round(level)));

/**
 * A light's brightness as a tall slider filled in its colour, as v1 drew it.
 * A drag goes out once it ends, a tap where it lands; keys step it at most
 * every 300 ms. 0 turns the light off.
 */
export function BrightnessSlider(props: {
  name: string;
  state: LightState;
  disabled?: boolean;
  failures?: number;
  onBrightness: (brightness: number) => void;
}) {
  const { state } = props;
  const disabled = props.disabled ?? false;
  const level = state.on && !disabled ? (state.brightness ?? 100) : 0;
  const preview = usePreview<number>(String(level), props.failures);
  const dragging = useRef<number | null>(null);
  const [isDragging, setDragging] = useState(false);
  const keys = useThrottledSend(props.onBrightness, !disabled);
  const shown = preview.value ?? level;

  useEffect(() => {
    if (!disabled) return;
    dragging.current = null;
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
    dragging.current = null;
    setDragging(false);
    // A previous command may still be in flight even when this matches
    // the reported level, so the final choice must always go out.
    props.onBrightness(to);
    preview.hold(to);
  };
  const Icon = shown >= 34 ? Sun : SunDim;

  return (
    <div className="flex flex-col items-center gap-4">
      <Icon aria-hidden="true" className="size-7 text-white/65" />
      <div
        onPointerDown={(event) => {
          // The slider's drags are its own, never the pages' swipes.
          event.stopPropagation();
          if (
            disabled ||
            event.button !== 0 ||
            event.isPrimary === false ||
            dragging.current !== null
          )
            return;
          keys.flush();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          dragging.current = event.pointerId;
          setDragging(true);
          preview.drag(at(event));
        }}
        onPointerMove={(event) => {
          if (dragging.current === event.pointerId) preview.drag(at(event));
        }}
        onPointerUp={(event) => {
          if (dragging.current === event.pointerId) end(at(event));
        }}
        onPointerCancel={(event) => {
          if (dragging.current !== event.pointerId) return;
          dragging.current = null;
          setDragging(false);
          preview.clear();
        }}
        onLostPointerCapture={(event) => {
          // A release the slider does not hear still ends the drag where
          // it was.
          if (dragging.current === event.pointerId && preview.value !== null) {
            end(preview.value);
          }
        }}
        data-dragging={isDragging ? "" : undefined}
        className="group relative h-72 w-24 overflow-hidden rounded-2xl bg-white/14 [touch-action:none] has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 origin-bottom transition-transform duration-150 group-data-dragging:transition-none motion-reduce:transition-none"
          style={{
            background: lightColour(state),
            transform: `scaleY(${shown / 100})`,
          }}
        />
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={shown}
          aria-label={`${props.name} brightness`}
          aria-valuetext={shown > 0 ? `${shown}%` : "Off"}
          disabled={disabled}
          onChange={(event) => {
            const brightness = Number(event.target.value);
            keys.send(brightness);
            preview.hold(brightness);
          }}
          onBlur={() => keys.flush()}
          className="sr-only"
        />
      </div>
      <span className="text-[13px] leading-[18px] font-medium text-(--silver)">
        {shown > 0 ? `${shown}%` : "Off"}
      </span>
    </div>
  );
}
