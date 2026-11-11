import type { LightState, SensorMeasure } from "@meetsanctum/app-sdk";

// The home's lights, switches, remotes, sensors and motion sensors as tiles:
// what a tile shows, which the shell works out from the core's devices and
// an app's page from its own draft, such as a mood's lights. The tiles draw
// it and say what was pressed; they hold no device state.

export type Tile = {
  key: string;
  deviceId: string;
  capabilityId: string;
  /**
   * A remote's tile switches nothing: it shows its latest press. Nor does a
   * sensor's, one for each device, which shows its readings, or a motion
   * sensor's (occupancy), which says whether it sees motion.
   */
  kind: "light" | "switch" | "button" | "sensor" | "occupancy";
  /** The room it is in, or null when it is in none the home has. */
  roomId: string | null;
  name: string;
  status: string;
  on: boolean;
  /**
   * Frosted glass when off, white when on or just pressed, its own colour
   * for a lit light.
   */
  look: "off" | "on" | "lit";
  /** A light's colour when lit. */
  colour?: string;
  /** Whether it is a light that dims, and its brightness while on. */
  dims: boolean;
  brightness?: number;
  disabled: boolean;
  /** A sensor's readings, in standard units, while it answers. */
  readings?: Partial<Record<SensorMeasure, number>>;
  /** What a sensor measures, whether it answers or not, which its icon says. */
  measures?: SensorMeasure[];
  /**
   * Whether a motion sensor sees motion, and when that last changed (null
   * when the core has not said), while it answers and has said either.
   */
  motion?: { occupied: boolean; changedAt: string | null };
  /** How many commands to it have failed here, so its tile shows each. */
  failures?: number;
};

export type TileSection = { id: string; title: string; tiles: Tile[] };

// A light's colour on its tile, mixed towards white so Carbon text stays
// readable on it. A light that only dims shows warm white.
const warmWhite = 370; // mireds, about 2,700 K
const towardsWhite = 0.45;

export function lightColour(state: LightState) {
  const rgb =
    state.colorMode === "color" &&
    state.hue !== undefined &&
    state.saturation !== undefined
      ? hueToRgb(state.hue, state.saturation / 100)
      : kelvinToRgb(1_000_000 / (state.colorTemperature ?? warmWhite));
  return hex(rgb, towardsWhite);
}

/** A colour temperature in mireds as its own colour, for a white's swatch. */
export function whiteOf(mireds: number) {
  return hex(kelvinToRgb(1_000_000 / mireds), 0);
}

const hex = (rgb: number[], towards: number) =>
  "#" +
  rgb
    .map((channel) =>
      Math.round(channel + (255 - channel) * towards)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

// A full-brightness colour from its hue and saturation.
function hueToRgb(hue: number, saturation: number) {
  const at = (n: number) => {
    const k = (n + hue / 60) % 6;
    return 255 * (1 - saturation * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return [at(5), at(3), at(1)];
}

// Tanner Helland's approximation of a colour temperature's RGB.
function kelvinToRgb(kelvin: number) {
  const t = kelvin / 100;
  const clamp = (value: number) => Math.max(0, Math.min(255, value));
  const red = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const green =
    t <= 66
      ? 99.4708025861 * Math.log(t) - 161.1195681661
      : 288.1221695283 * (t - 60) ** -0.0755148492;
  const blue =
    t >= 66
      ? 255
      : t <= 19
        ? 0
        : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [clamp(red), clamp(green), clamp(blue)];
}
