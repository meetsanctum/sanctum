import type { TemperatureUnit } from "@meetsanctum/app-sdk";

// Temperatures and other readings as the household reads them (v1's
// temperature.ts, and how its sensors, history and weather used it).
// Standard types and sensors keep temperatures in Celsius; a page converts
// them as it draws, into the unit the home shows, which the household sets
// in Settings → Household and the shell hands every page
// (temperature-unit.tsx). A reading that carries its own unit says it, such
// as "°C", "%" or "hPa".

type TemperatureOptions = {
  /** The unit the value is in: Celsius unless said. */
  from?: TemperatureUnit;
  /** "21°" rather than "21°C", where the unit is clear from the page. */
  compact?: boolean;
  /** Whole degrees, as a forecast shows them, rather than tenths. */
  whole?: boolean;
};

/** The temperature unit a reading's own unit names, such as "°C" or "F"; null for any other. */
export function temperatureUnitOf(unit: string): TemperatureUnit | null {
  const normalized = unit.trim().toLowerCase().replaceAll("°", "");
  if (normalized === "c" || normalized === "celsius") return "celsius";
  if (normalized === "f" || normalized === "fahrenheit") return "fahrenheit";
  return null;
}

export function convertTemperature(
  value: number,
  from: TemperatureUnit,
  to: TemperatureUnit,
) {
  if (from === to) return value;
  return from === "celsius" ? value * 1.8 + 32 : ((value - 32) * 5) / 9;
}

/** A number as readings show it: whole when it is within 0.05 of one, else to a tenth. */
export function formatNumber(value: number) {
  const whole = Math.round(value);
  // Math.round gives -0 for small negatives.
  if (Math.abs(value - whole) < 0.05) return String(whole || 0);
  return value.toFixed(1);
}

function degrees(value: number, options: TemperatureOptions) {
  return options.whole ? String(Math.round(value) || 0) : formatNumber(value);
}

function symbol(unit: TemperatureUnit, compact = false) {
  return compact ? "°" : unit === "celsius" ? "°C" : "°F";
}

/** A temperature in the unit shown, such as "21.5°C", "71°F" or "21°"; a dash while there is none. */
export function formatTemperature(
  value: number | null,
  shown: TemperatureUnit,
  options: TemperatureOptions = {},
) {
  if (value === null) return "–";
  const converted = convertTemperature(value, options.from ?? "celsius", shown);
  return `${degrees(converted, options)}${symbol(shown, options.compact)}`;
}

/** The lowest and highest of some temperatures, such as "19–22°C", or one when they are the same. */
export function formatTemperatureRange(
  min: number,
  max: number,
  shown: TemperatureUnit,
  options: TemperatureOptions = {},
) {
  const from = options.from ?? "celsius";
  const [low, high] = [
    convertTemperature(min, from, shown),
    convertTemperature(max, from, shown),
  ]
    .map((value) => degrees(value, options))
    .sort((a, b) => Number(a) - Number(b));
  return `${low === high ? low : `${low}–${high}`}${symbol(shown, options.compact)}`;
}

/**
 * The number a reading shows and its unit, such as a sensor's or its
 * history's: a temperature in the unit shown, anything else as it is.
 */
export function shownReading(
  value: number,
  unit: string,
  shown: TemperatureUnit,
) {
  const from = temperatureUnitOf(unit);
  return from
    ? { value: convertTemperature(value, from, shown), unit: symbol(shown) }
    : { value, unit };
}

/** A reading with its unit, such as "48%", "1013 hPa" or, in the unit shown, "72.5°F". */
export function formatReading(
  value: number,
  unit: string,
  shown: TemperatureUnit,
  options: Pick<TemperatureOptions, "compact"> = {},
) {
  const from = temperatureUnitOf(unit);
  if (from) return formatTemperature(value, shown, { ...options, from });
  const trimmed = unit.trim();
  if (!trimmed) return formatNumber(value);
  // A percentage or degrees of an angle sit right after the number.
  return `${formatNumber(value)}${/^[%°]/.test(trimmed) ? "" : " "}${trimmed}`;
}

// A light level's number: whole lux under 100 and two figures from 100, so
// it reads as steadily as a room's light changes.
function lux(value: number) {
  const level = Math.max(0, value);
  const shown = level < 99.5 ? Math.round(level) : Number(level.toPrecision(2));
  return shown.toLocaleString("en-GB");
}

/** A light level, in lux, as readings show it: "4 lx", "320 lx", "1,100 lx". */
export function formatLightLevel(value: number) {
  return `${lux(value)} lx`;
}

/** The lowest and highest of some light levels, such as "40–320 lx", or one when they read the same. */
export function formatLightLevelRange(min: number, max: number) {
  const [low, high] = [lux(Math.min(min, max)), lux(Math.max(min, max))];
  return `${low === high ? low : `${low}–${high}`} lx`;
}
