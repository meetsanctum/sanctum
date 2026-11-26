import type {
  LightCommand,
  LightFeatures,
  LightState,
} from "@meetsanctum/app-sdk";
import { Palette, Power, Sun, SunDim, Thermometer } from "lucide-react";
import { useEffect, useRef } from "react";

import { LevelSlider } from "./level-slider";
import { LightPicker } from "./light-picker";
import { showFailed } from "./show-failed";
import { SwipePages, type SwipePage } from "./swipe-pages";
import { lightColour } from "./tiles";

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
  /** The page it opens on, by its id: the first unless said. */
  initial?: string;
  /** Called in a transition after the page selection commits, including on open. */
  onPageChange?: (id: string) => void;
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
      <SwipePages
        label={name}
        pages={pages}
        initial={props.initial}
        onPageChange={props.onPageChange}
      />
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

/**
 * A light's brightness as a tall slider filled in its colour. A drag goes
 * out once it ends, a tap where it lands; keys step it at most every 300 ms.
 * 0 turns the light off.
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
  const words = (shown: number) => (shown > 0 ? `${shown}%` : "Off");
  return (
    <LevelSlider
      label={`${props.name} brightness`}
      level={level}
      fill={lightColour(state)}
      valueText={words}
      disabled={disabled}
      failures={props.failures}
      onLevel={props.onBrightness}
      frame={(slider, shown) => {
        const Icon = shown >= 34 ? Sun : SunDim;
        return (
          <div className="flex flex-col items-center gap-4">
            <Icon aria-hidden="true" className="size-7 text-white/65" />
            {slider}
            <span className="text-[13px] leading-[18px] font-medium text-(--silver)">
              {words(shown)}
            </span>
          </div>
        );
      }}
    />
  );
}
