// Zigbee2MQTT's values and the capability kinds' (light, switch), ported
// from v1's zigbee2mqtt-values.ts and zigbee2mqtt-model.ts (Pragmata,
// v1-final).

export function numericValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A light's brightness, from Zigbee's 0–254 to 0–100. Any level of 1 or
 * more is at least 1%, so a light that is on is never at 0 unless Zigbee
 * says 0. Each percentage comes back from brightnessToZigbee unchanged, so
 * the report confirms what a command asked for.
 */
export function brightnessFromZigbee(brightness: number) {
  if (brightness <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(1, Math.round((brightness / 254) * 100)));
}

/** A light's brightness, from 0–100 to Zigbee's 0–254. */
export function brightnessToZigbee(brightness: number) {
  if (brightness <= 0) {
    return 0;
  }
  return Math.min(254, Math.max(1, Math.round((brightness / 100) * 254)));
}

/** Whether a binary feature, such as a light's state, reads as on. */
export function powerValue(
  value: unknown,
  values: { on: unknown; off: unknown } = { on: "ON", off: "OFF" },
) {
  if (value === values.on) return true;
  if (value === values.off) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const upper = value.toUpperCase();
    if (upper === "ON") return true;
    if (upper === "OFF") return false;
  }
  return null;
}

/** Zigbee2MQTT's colour mode as the light kind names it. */
export function colorModeValue(value: unknown) {
  if (value === "color_temp") {
    return "temperature" as const;
  }
  if (value === "hs" || value === "xy") {
    return "color" as const;
  }
  return null;
}

/**
 * A device's availability message: `{"state":"online"}`, or plain text from
 * Zigbee2MQTT's legacy format.
 */
export function availabilityValue(payload: Buffer) {
  const raw = payload.toString("utf8").trim();
  let state: unknown = raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && "state" in parsed) {
      state = parsed.state;
    }
  } catch {
    // Plain text, as the legacy format sends it.
  }
  return String(state).trim().toLowerCase() === "online"
    ? ("online" as const)
    : ("offline" as const);
}

/** A JSON payload, or null when it is not one. */
export function parseJson(payload: Buffer): unknown {
  try {
    return JSON.parse(payload.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}
