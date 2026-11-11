import {
  light,
  type LightCommand,
  type LightMove,
  type LightState,
  type SwitchCommand,
  type SwitchState,
} from "@meetsanctum/app-sdk";

import type { LightMapping, SwitchMapping } from "./exposes.js";
import {
  brightnessFromZigbee,
  brightnessToZigbee,
  colorModeValue,
  isRecord,
  numericValue,
  powerValue,
} from "./values.js";

// A device's messages onto each capability's state, and the core's commands
// and moves onto what Zigbee2MQTT takes on <device>/set. Ported from v1's
// stateFromPayload and commandPayload (zigbee2mqtt-model.ts, Pragmata
// v1-final). v1 filled what a message left out from the state it kept; a
// driver reports only what the device said, and the core keeps the rest.

const mireds = { min: 50, max: 1000 };

function lightState(
  mapping: LightMapping,
  payload: Record<string, unknown>,
  on: boolean,
): LightState | null {
  const state: LightState = { on };
  if (mapping.brightness) {
    const brightness = numericValue(payload[mapping.brightness]);
    // Every report says the brightness Zigbee2MQTT gives, off included; the
    // core keeps the one a light comes back at. A light that is on is never
    // at 0, which the core would not know what to make of.
    if (brightness !== null && (!on || brightness > 0)) {
      state.brightness = brightnessFromZigbee(brightness);
    }
  }
  if (mapping.colorTemperature) {
    const mired = numericValue(payload[mapping.colorTemperature]);
    if (mired !== null && mired >= mireds.min && mired <= mireds.max) {
      state.colorTemperature = Math.round(mired);
    }
  }
  if (mapping.color) {
    const color = payload[mapping.color];
    const hue = isRecord(color) ? numericValue(color.hue ?? color.h) : null;
    const saturation = isRecord(color)
      ? numericValue(color.saturation ?? color.s)
      : null;
    if (
      hue !== null &&
      saturation !== null &&
      hue >= 0 &&
      hue <= 360 &&
      saturation >= 0 &&
      saturation <= 100
    ) {
      state.hue = hue;
      state.saturation = saturation;
    }
  }
  const { colorTemperature, color } = mapping.features;
  if (colorTemperature || color) {
    // A light that can do only one of the two is in that mode.
    const only = color ? (colorTemperature ? null : "color") : "temperature";
    const mode = colorModeValue(payload[mapping.colorMode]) ?? only;
    if (mode) {
      state.colorMode = mode;
    }
  }
  // Whatever a device sends, the core never gets a state it would refuse.
  return light.state.safeParse(state).success ? state : null;
}

/**
 * One capability's whole state from a device's message, or null when the
 * message does not say whether it is on.
 */
export function stateFromPayload(
  mapping: LightMapping | SwitchMapping,
  payload: Record<string, unknown>,
): LightState | SwitchState | null {
  const on = powerValue(payload[mapping.state.property], mapping.state);
  if (on === null) {
    return null;
  }
  return mapping.kind === "light" ? lightState(mapping, payload, on) : { on };
}

function lightPayload(mapping: LightMapping, command: LightCommand) {
  const payload: Record<string, unknown> = {};
  if (command.on !== undefined) {
    payload[mapping.state.property] = command.on
      ? mapping.state.on
      : mapping.state.off;
  }
  if (command.brightness !== undefined && mapping.brightness) {
    payload[mapping.brightness] = brightnessToZigbee(command.brightness);
  }
  if (command.colorTemperature !== undefined && mapping.colorTemperature) {
    payload[mapping.colorTemperature] = command.colorTemperature;
  }
  if (
    command.hue !== undefined &&
    command.saturation !== undefined &&
    mapping.color
  ) {
    payload[mapping.color] = {
      hue: command.hue,
      saturation: command.saturation,
    };
  }
  if (command.transitionSeconds !== undefined) {
    payload.transition = command.transitionSeconds;
  }
  return payload;
}

/** What to publish on <device>/set for a command the core prepared. */
export function commandPayload(
  mapping: LightMapping | SwitchMapping,
  command: LightCommand | SwitchCommand,
): Record<string, unknown> {
  if (mapping.kind === "light") {
    return lightPayload(mapping, command as LightCommand);
  }
  return {
    [mapping.state.property]: (command as SwitchCommand).on
      ? mapping.state.on
      : mapping.state.off,
  };
}

/**
 * What to publish on <device>/set to move a light's brightness, or stop it:
 * Zigbee2MQTT's brightness_move, at levels of 0 to 254 a second, which sends
 * the level cluster's move and leaves the light on at its lowest; its stop
 * reads the light back half a second later. None for a light that cannot
 * dim.
 */
export function movePayload(
  mapping: LightMapping,
  move: LightMove,
): Record<string, unknown> | null {
  if (!mapping.brightness) {
    return null;
  }
  // brightness_l1's move is brightness_move_l1.
  const property = mapping.brightness.replace(/^brightness/, "brightness_move");
  if (move.move === "stop") {
    return { [property]: "stop" };
  }
  const rate = Math.max(1, Math.round((move.percentPerSecond * 254) / 100));
  return { [property]: move.move === "up" ? rate : -rate };
}
