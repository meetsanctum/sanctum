import type {
  LightCommand,
  LightState,
  MotionState,
  SensorState,
  SwitchState,
} from "@meetsanctum/app-sdk";
import type { Entity, TelemetryEvent } from "esphome-client";

import { colorModesOf, measureOf, type Mapped } from "./entities.js";

// Between ESPHome's states and commands and Sanctum's: a light's brightness
// and colour as fractions and colour modes there, percentages, mireds and
// hue there; readings in each measure's standard unit.

const whiteBit = 4;
const temperatureBits = 8 | 16;
const colorBit = 32;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

// Hue in degrees and saturation in percent from red, green and blue in 0–1.
function hueOf(red: number, green: number, blue: number) {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
  }
  return {
    hue: Math.round((hue * 60 + 360) % 360),
    saturation: max === 0 ? 0 : Math.round((delta / max) * 100),
  };
}

// Red, green and blue in 0–1, at full value, from hue and saturation.
function rgbOf(hue: number, saturation: number) {
  const s = saturation / 100;
  const sector = (hue % 360) / 60;
  const x = s * (1 - Math.abs((sector % 2) - 1));
  const [r, g, b] =
    sector < 1
      ? [s, x, 0]
      : sector < 2
        ? [x, s, 0]
        : sector < 3
          ? [0, s, x]
          : sector < 4
            ? [0, x, s]
            : sector < 5
              ? [x, 0, s]
              : [s, 0, x];
  const m = 1 - s;
  return { r: r + m, g: g + m, b: b + m };
}

/** A light's state as Sanctum has it, from ESPHome's. */
export function lightStateOf(
  mapped: Mapped,
  event: TelemetryEvent & { type: "light" },
): LightState {
  const features = mapped.capability.features as {
    brightness: boolean;
    colorTemperature: { min: number; max: number } | null;
    color: boolean;
  };
  const state: LightState = { on: event.state === true };
  if (
    features.brightness &&
    typeof event.brightness === "number" &&
    Number.isFinite(event.brightness)
  ) {
    state.brightness = clamp(Math.round(event.brightness * 100), 0, 100);
  }
  const mode = event.colorMode ?? 0;
  // A mode with white beside colour shines colour only while its colour
  // channel is up: its last colour stays set while it shines white.
  const isColor =
    (mode & colorBit) !== 0 &&
    ((mode & (temperatureBits | whiteBit)) === 0 ||
      (event.colorBrightness ?? 0) > 0);
  if (features.color && isColor) {
    const rgb = [event.red ?? 0, event.green ?? 0, event.blue ?? 0] as const;
    if (
      rgb.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    ) {
      state.colorMode = "color";
      Object.assign(state, hueOf(...rgb));
    }
  } else if (
    features.colorTemperature &&
    (mode & temperatureBits) !== 0 &&
    typeof event.colorTemperature === "number" &&
    Number.isFinite(event.colorTemperature)
  ) {
    state.colorMode = "temperature";
    state.colorTemperature = clamp(
      Math.round(event.colorTemperature),
      features.colorTemperature.min,
      features.colorTemperature.max,
    );
  }
  return state;
}

// The first of a light's modes that has these bits, by preference.
function modeWith(entity: Entity, preferred: readonly number[]) {
  const modes = colorModesOf(entity);
  return preferred.find((mode) => modes.includes(mode));
}

/** ESPHome's light command for Sanctum's, whatever it leaves out staying as it is. */
export function lightCommandOf(entity: Entity, command: LightCommand) {
  const options: Record<string, unknown> = {};
  if (command.on !== undefined) options.state = command.on;
  if (command.brightness !== undefined) {
    if (command.brightness === 0) options.state = false;
    else {
      options.brightness = command.brightness / 100;
      options.state ??= true;
    }
  }
  if (command.colorTemperature !== undefined) {
    options.colorTemperature = command.colorTemperature;
    // COLOR_TEMPERATURE, then the modes that have it beside colour.
    const mode = modeWith(entity, [11, 19, 47, 51]);
    if (mode !== undefined) {
      options.colorMode = mode;
      if ((mode & colorBit) !== 0) options.colorBrightness = 0;
      if (mode === 47) options.white = 1;
    }
  }
  if (command.hue !== undefined && command.saturation !== undefined) {
    options.rgb = rgbOf(command.hue, command.saturation);
    // RGB, then the modes that have white beside it.
    const mode = modeWith(entity, [35, 39, 47, 51]);
    if (mode !== undefined) {
      options.colorMode = mode;
      // Combined modes retain their channel levels across commands.
      options.colorBrightness = 1;
      if (mode === 39 || mode === 47) options.white = 0;
      if (mode === 51) {
        options.coldWhite = 0;
        options.warmWhite = 0;
      }
    }
  }
  if (command.transitionSeconds !== undefined) {
    options.transitionLength = Math.round(command.transitionSeconds * 1000);
  }
  return options;
}

// Kelvin and degrees Fahrenheit in degrees Celsius, to a tenth.
function celsiusOf(value: number, unit: string) {
  const celsius =
    unit === "°F"
      ? ((value - 32) * 5) / 9
      : unit === "K"
        ? value - 273.15
        : value;
  return Math.round(celsius * 10) / 10;
}

/**
 * What one state event says of its capability, in that kind's shape, or
 * null where it says nothing Sanctum keeps, as a sensor without a reading.
 */
export function stateOf(
  mapped: Mapped,
  event: TelemetryEvent,
):
  | LightState
  | SwitchState
  | SensorState
  | MotionState
  | { open: boolean }
  | null {
  const { capability, entity } = mapped;
  if (event.type === "light") return lightStateOf(mapped, event);
  if (event.type === "switch") return { on: event.state === true };
  if (event.type === "sensor") {
    if (event.missingState) return null;
    // A reading of zero comes with no value at all, as a protocol buffer
    // leaves out its defaults.
    const reading = event.state ?? 0;
    if (typeof reading !== "number" || !Number.isFinite(reading)) return null;
    const unit =
      entity.type === "sensor" ? (entity.unitOfMeasurement ?? "") : "";
    const value =
      measureOf(entity) === "temperature"
        ? celsiusOf(reading, unit)
        : Math.round(reading * 10) / 10;
    return { value };
  }
  if (event.type === "binary_sensor") {
    if (event.missingState) return null;
    return capability.kind === "motion"
      ? { motion: event.state === true }
      : { open: event.state === true };
  }
  return null;
}
