import type {
  LightCommand,
  LightFeatures,
  LightState,
} from "@meetsanctum/app-sdk";
import {
  ArrowLeft,
  Check,
  Lightbulb,
  LightbulbOff,
  Palette,
  Pencil,
  Thermometer,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

import { whiteOf } from "./tiles";
import { usePreview } from "./use-preview";
import { useThrottledSend } from "./use-throttled-send";

// A light's colour and white, as v1 drew them: eight colours on a ring with
// the current one in the middle, which opens its shades and then a colour
// wheel; eight whites across the light's own range, whose middle opens a
// white wheel. Picking one turns the light on. A drag on a wheel goes out
// once it ends; keys step a wheel at most every 300 ms. Below the ring,
// Colour and White switch between the two, each only where the light has it,
// and a button switches the light.

type Colour = { hue: number; saturation: number };
type Range = { min: number; max: number };
type Appearance = "color" | "temperature";
type Layer = "ring" | "shades" | "wheel";

const bases = [
  ["Red", 0],
  ["Orange", 28],
  ["Yellow", 48],
  ["Lime", 76],
  ["Green", 132],
  ["Cyan", 190],
  ["Blue", 220],
  ["Magenta", 300],
] as const;
const shades = [20, 35, 50, 65, 80, 100];
// The shades go around the ring, leaving its top for Back and its bottom
// for Done.
const shadeSlots = [1, 2, 3, 5, 6, 7];
const whites = 8;
// How far out from the middle the ring's circles sit, and a wheel's Back
// and Done, in % of the picker.
const ring = 39;
const outside = 64;
// A wheel's full colour sits this far out, as a share of its radius; a
// white wheel runs from cool at `whiteTop` % down to warm, over `whiteSpan` %.
const reach = 0.88;
const whiteTop = 8;
const whiteSpan = 84;

const swatch = ({ hue, saturation }: Colour) =>
  `hsl(${hue} ${saturation}% 52%)`;

// Slot `slot` of `of` around the middle, clockwise from the top, `distance`
// % out, as % of the picker.
function around(slot: number, of: number, distance: number) {
  const angle = ((-90 + (360 / of) * slot) * Math.PI) / 180;
  return {
    x: 50 + Math.cos(angle) * distance,
    y: 50 + Math.sin(angle) * distance,
  };
}

const hueGap = (a: number, b: number) => {
  const gap = Math.abs(a - b) % 360;
  return Math.min(gap, 360 - gap);
};
const nearest = <T,>(values: readonly T[], gap: (value: T) => number) =>
  values.reduce((best, value) => (gap(value) < gap(best) ? value : best));
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const kelvin = (mireds: number) => Math.round(1_000_000 / mireds / 100) * 100;
const kelvinText = (mireds: number) => `${kelvin(mireds).toLocaleString()} K`;

// Whites spread evenly across a light's range, coolest first.
function whitesOf(range: Range) {
  return [
    ...new Set(
      Array.from({ length: whites }, (_, index) =>
        Math.round(
          range.min + ((range.max - range.min) * index) / (whites - 1),
        ),
      ),
    ),
  ];
}

export function LightPicker(props: {
  name: string;
  features: LightFeatures;
  state: LightState;
  disabled?: boolean;
  /** How many commands to the light have failed here, so a preview drops. */
  failures?: number;
  onCommand: (command: LightCommand) => void;
}) {
  const { name, features, state, onCommand } = props;
  const disabled = props.disabled ?? false;
  const range = features.colorTemperature;
  const canColour = features.color;
  const [chosen, setAppearance] = useState<Appearance>(() =>
    canColour && (state.colorMode === "color" || !range)
      ? "color"
      : "temperature",
  );
  const appearance: Appearance =
    !range || (chosen === "color" && canColour) ? "color" : "temperature";
  const [layer, setLayer] = useState<Layer>("ring");
  const picker = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);

  // Shades must use the colour just chosen, even before the device answers.
  const preview = usePreview<Colour>(
    `${state.colorMode}/${state.hue}/${state.saturation}/${disabled}`,
    props.failures,
  );
  const inColour =
    preview.value !== null ||
    (state.colorMode === "color" && state.hue !== undefined);
  const colour: Colour =
    preview.value ??
    (inColour
      ? { hue: state.hue!, saturation: state.saturation ?? 100 }
      : { hue: 0, saturation: 100 });
  const presets = range ? whitesOf(range) : [];
  const inWhite =
    !inColour && range !== null && state.colorTemperature !== undefined;
  const mireds = range
    ? clamp(
        state.colorTemperature ?? presets[Math.floor(presets.length / 2)]!,
        range.min,
        range.max,
      )
    : 0;
  const on = state.on && !disabled;

  // A new layer's circles fly out from the middle, and focus moves to it
  // when a press inside the picker opened it.
  useLayoutEffect(() => {
    const box = picker.current;
    if (!box) return;
    const size = box.offsetWidth;
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    box.querySelectorAll<HTMLElement>("[data-fly]").forEach((circle, index) => {
      const dx = ((50 - Number(circle.dataset.x)) / 100) * size;
      const dy = ((50 - Number(circle.dataset.y)) / 100) * size;
      circle.animate?.(
        reduced
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              {
                opacity: 0,
                transform: `translate(${dx}px, ${dy}px) scale(0.4)`,
              },
              { opacity: 1, transform: "none" },
            ],
        {
          duration: reduced ? 150 : 360,
          delay: index * 15,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "backwards",
        },
      );
    });
    if (refocus.current) {
      refocus.current = false;
      box.querySelector<HTMLElement>("[data-first]")?.focus();
    }
  }, [layer, appearance]);

  const open = (next: Layer) => {
    refocus.current = true;
    setLayer(next);
  };
  const pick = (command: LightCommand) => {
    if (command.hue !== undefined && command.saturation !== undefined) {
      preview.hold({ hue: command.hue, saturation: command.saturation });
    } else if (command.colorTemperature !== undefined) {
      preview.clear();
    }
    onCommand({ on: true, ...command });
  };

  const circles: ReactNode[] = [];
  if (appearance === "color" && layer === "ring") {
    const selected = inColour
      ? nearest(bases, ([, hue]) => hueGap(hue, colour.hue))[1]
      : undefined;
    bases.forEach(([label, hue], index) =>
      circles.push(
        <Circle
          key={label}
          at={around(index, bases.length, ring)}
          colour={swatch({ hue, saturation: 100 })}
          label={label}
          selected={selected === hue}
          disabled={disabled}
          onClick={() => {
            pick({ hue, saturation: 100 });
            open("shades");
          }}
        />,
      ),
    );
    circles.push(
      <Middle
        key="middle"
        colour={swatch(colour)}
        label="Shades"
        disabled={disabled}
        onClick={() => open("shades")}
      />,
    );
  } else if (appearance === "color" && layer === "shades") {
    const selected = inColour
      ? nearest(shades, (shade) => Math.abs(shade - colour.saturation))
      : undefined;
    shades.forEach((saturation, index) =>
      circles.push(
        <Circle
          key={saturation}
          at={around(shadeSlots[index]!, 8, ring)}
          colour={swatch({ hue: colour.hue, saturation })}
          label={`${saturation}% saturation`}
          selected={selected === saturation}
          disabled={disabled}
          onClick={() => pick({ hue: colour.hue, saturation })}
        />,
      ),
    );
    circles.push(
      <Circle
        key="back"
        at={around(0, 8, ring)}
        icon={ArrowLeft}
        label="Back to colours"
        disabled={disabled}
        onClick={() => open("ring")}
      />,
      <Circle
        key="done"
        at={around(4, 8, ring)}
        icon={Check}
        label="Done with shades"
        disabled={disabled}
        onClick={() => open("ring")}
      />,
      <Middle
        key="middle"
        colour={swatch(colour)}
        label="Colour wheel"
        disabled={disabled}
        onClick={() => open("wheel")}
      />,
    );
  } else if (appearance === "temperature" && layer !== "wheel") {
    const selected = inWhite
      ? nearest(presets, (preset) => Math.abs(preset - mireds))
      : undefined;
    presets.forEach((preset, index) =>
      circles.push(
        <Circle
          key={preset}
          at={around(index, presets.length, ring)}
          colour={whiteOf(preset)}
          label={kelvinText(preset)}
          selected={selected === preset}
          disabled={disabled}
          onClick={() => pick({ colorTemperature: preset })}
        />,
      ),
    );
    circles.push(
      <Middle
        key="middle"
        colour={whiteOf(mireds)}
        label="White wheel"
        disabled={disabled}
        onClick={() => open("wheel")}
      />,
    );
  } else {
    const white = appearance === "temperature";
    circles.push(
      <Circle
        key="back"
        at={around(11, 12, outside)}
        icon={ArrowLeft}
        label={white ? "Back to whites" : "Back to shades"}
        disabled={disabled}
        onClick={() => open(white ? "ring" : "shades")}
      />,
      <Circle
        key="done"
        at={around(1, 12, outside)}
        icon={Check}
        label="Done with the wheel"
        disabled={disabled}
        onClick={() => open("ring")}
      />,
    );
  }

  // A wheel's Back and Done reach 44 px above the picker, so it keeps that
  // room above itself whatever it shows.
  return (
    <div className="flex flex-col items-center gap-11 pt-11">
      <div ref={picker} className="relative size-72 shrink-0">
        {layer === "wheel" && (
          <Wheel
            name={name}
            white={appearance === "temperature" ? range : null}
            colour={inColour ? colour : { hue: colour.hue, saturation: 0 }}
            mireds={mireds}
            disabled={disabled}
            failures={props.failures}
            onPick={(picked) =>
              pick(
                "mireds" in picked
                  ? { colorTemperature: picked.mireds }
                  : picked,
              )
            }
          />
        )}
        {circles}
      </div>
      <div className="flex justify-center gap-5">
        {canColour && (
          <Mode
            icon={Palette}
            label="Colour"
            pressed={appearance === "color"}
            disabled={disabled}
            onClick={() => {
              setAppearance("color");
              setLayer("ring");
            }}
          />
        )}
        {range && (
          <Mode
            icon={Thermometer}
            label="White"
            pressed={appearance === "temperature"}
            disabled={disabled}
            onClick={() => {
              setAppearance("temperature");
              setLayer("ring");
            }}
          />
        )}
        <Mode
          icon={on ? Lightbulb : LightbulbOff}
          label={on ? "On" : "Off"}
          ariaLabel={`Turn ${state.on ? "off" : "on"}`}
          pressed={on}
          disabled={disabled}
          onClick={() => onCommand({ on: !state.on })}
        />
      </div>
    </div>
  );
}

// A round button on the ring: a colour, a white or Back and Done. A chosen
// colour or white is ringed in White.
function Circle(props: {
  at: { x: number; y: number };
  colour?: string;
  icon?: LucideIcon;
  label: string;
  selected?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.icon ? undefined : (props.selected ?? false)}
      disabled={props.disabled}
      data-fly=""
      data-x={props.at.x}
      data-y={props.at.y}
      onClick={props.onClick}
      style={{
        left: `${props.at.x}%`,
        top: `${props.at.y}%`,
        background: props.colour,
      }}
      className="absolute grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/14 text-white outline-none focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ring/70 aria-pressed:ring-3 aria-pressed:ring-white"
    >
      {Icon && <Icon aria-hidden="true" className="size-6" />}
    </button>
  );
}

// The middle of the ring: the current colour or white, which opens the next
// layer.
function Middle(props: {
  colour: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      data-first=""
      onClick={props.onClick}
      style={{ background: props.colour }}
      className="absolute top-1/2 left-1/2 grid size-24 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-white outline-none focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ring/70"
    >
      <Pencil
        aria-hidden="true"
        className="size-7 drop-shadow-[0_1px_4px_rgb(0_0_0/0.65)]"
      />
    </button>
  );
}

// One of the round buttons under the ring, its label below it; White
// while pressed.
function Mode(props: {
  icon: LucideIcon;
  label: string;
  ariaLabel?: string;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      aria-label={props.ariaLabel}
      aria-pressed={props.ariaLabel ? undefined : props.pressed}
      data-on={props.pressed ? "" : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
      className="group flex w-16 flex-col items-center gap-2 outline-none"
    >
      <span className="grid size-12 place-items-center rounded-full bg-white/14 text-white group-focus-visible:ring-3 group-focus-visible:ring-ring/50 group-data-on:bg-white group-data-on:text-(--carbon)">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <span className="text-xs font-medium text-white/65 group-data-on:text-white">
        {props.label}
      </span>
    </button>
  );
}

// A colour wheel, or a white wheel from cool at the top to warm at the
// bottom, with a pin where the light is. A drag shows where it is and goes
// out once it ends; keys step hue and saturation, or the white, as sliders
// that send at most every 300 ms.
function Wheel(props: {
  name: string;
  /** The light's range for a white wheel; null for a colour wheel. */
  white: Range | null;
  colour: Colour;
  mireds: number;
  disabled: boolean;
  failures?: number;
  onPick: (picked: Colour | { mireds: number }) => void;
}) {
  const { white, disabled, onPick } = props;
  const preview = usePreview<Colour | { mireds: number }>(
    `${props.colour.hue}/${props.colour.saturation}/${props.mireds}`,
    props.failures,
  );
  const dragging = useRef<number | null>(null);
  const keys = useThrottledSend(onPick, !disabled);

  useEffect(() => {
    if (!disabled) return;
    dragging.current = null;
    preview.clear();
  }, [disabled, preview.clear]);

  const shownColour =
    preview.value && "hue" in preview.value ? preview.value : props.colour;
  const shownMireds =
    preview.value && "mireds" in preview.value
      ? preview.value.mireds
      : props.mireds;

  const at = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (white) {
      const down = ((event.clientY - box.top) / (box.height || 1)) * 100;
      const share = clamp((down - whiteTop) / whiteSpan, 0, 1);
      return {
        mireds: Math.round(white.min + (white.max - white.min) * share),
      };
    }
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    const radius = (box.width || 1) / 2;
    return {
      hue: Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360),
      saturation: Math.round(
        Math.min(1, Math.hypot(dx, dy) / (radius * reach)) * 100,
      ),
    };
  };
  const end = (picked: Colour | { mireds: number }) => {
    dragging.current = null;
    onPick(picked);
    preview.hold(picked);
  };

  let pin: { x: number; y: number; fill: string };
  let background: string;
  if (white) {
    const share =
      white.max === white.min
        ? 0
        : (clamp(shownMireds, white.min, white.max) - white.min) /
          (white.max - white.min);
    pin = {
      x: 50,
      y: whiteTop + share * whiteSpan,
      fill: whiteOf(shownMireds),
    };
    background = `radial-gradient(circle at 50% 50%, rgb(255 255 255 / 0.42) 0 16%, rgb(255 255 255 / 0.12) 46%, rgb(255 255 255 / 0) 72%), linear-gradient(to bottom, ${whiteOf(white.min)}, ${whiteOf((white.min + white.max) / 2)}, ${whiteOf(white.max)})`;
  } else {
    const angle = (shownColour.hue * Math.PI) / 180;
    const out = (shownColour.saturation / 100) * reach * 50;
    pin = {
      x: 50 + Math.sin(angle) * out,
      y: 50 - Math.cos(angle) * out,
      fill: swatch(shownColour),
    };
    background =
      "radial-gradient(circle at 50% 50%, #fff 0 8%, rgb(255 255 255 / 0.72) 20%, rgb(255 255 255 / 0) 68%), conic-gradient(hsl(0 100% 50%), hsl(60 100% 50%), hsl(120 100% 50%), hsl(180 100% 50%), hsl(240 100% 50%), hsl(300 100% 50%), hsl(360 100% 50%))";
  }

  const step = (picked: Colour | { mireds: number }) => {
    keys.send(picked);
    preview.hold(picked);
  };
  const leave = () => keys.flush();
  const input = "sr-only";

  return (
    <div
      onPointerDown={(event) => {
        // The wheel's drags are its own, never the pages' swipes.
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
        preview.clear();
      }}
      onLostPointerCapture={(event) => {
        // A release the wheel does not hear still ends the drag where it
        // was.
        if (dragging.current === event.pointerId && preview.value) {
          end(preview.value);
        }
      }}
      style={{ background }}
      className="absolute inset-0 animate-in rounded-full duration-200 fade-in-0 [touch-action:none] has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50"
    >
      <svg
        aria-hidden="true"
        width="40"
        height="48"
        viewBox="0 0 40 48"
        className="pointer-events-none absolute -translate-x-1/2 -translate-y-full"
        style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
      >
        <path
          d="M20 47C17.8 43.6 13.3 39.9 9.7 35.4 6.2 31 3 25.7 3 19.5 3 8.9 10.1 2 20 2c9.9 0 17 6.9 17 17.5 0 6.2-3.2 11.5-6.7 15.9-3.6 4.5-8.1 8.2-10.3 11.6Z"
          fill={pin.fill}
          stroke="#fff"
          strokeWidth="2.5"
        />
      </svg>
      {white ? (
        <input
          type="range"
          data-first=""
          min={Math.ceil(1_000_000 / white.max)}
          max={Math.floor(1_000_000 / white.min)}
          step={100}
          value={Math.round(1_000_000 / shownMireds)}
          aria-label={`${props.name} white`}
          aria-valuetext={kelvinText(shownMireds)}
          disabled={disabled}
          onChange={(event) =>
            step({
              mireds: clamp(
                Math.round(1_000_000 / Number(event.target.value)),
                white.min,
                white.max,
              ),
            })
          }
          onBlur={leave}
          className={input}
        />
      ) : (
        <>
          <input
            type="range"
            data-first=""
            min={0}
            max={359}
            step={5}
            value={shownColour.hue}
            aria-label={`${props.name} hue`}
            aria-valuetext={`${shownColour.hue}°`}
            disabled={disabled}
            onChange={(event) =>
              // A white light's hue comes on in full colour.
              step({
                hue: Number(event.target.value),
                saturation: shownColour.saturation || 100,
              })
            }
            onBlur={leave}
            className={input}
          />
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={shownColour.saturation}
            aria-label={`${props.name} saturation`}
            aria-valuetext={`${shownColour.saturation}%`}
            disabled={disabled}
            onChange={(event) =>
              step({ ...shownColour, saturation: Number(event.target.value) })
            }
            onBlur={leave}
            className={input}
          />
        </>
      )}
    </div>
  );
}
