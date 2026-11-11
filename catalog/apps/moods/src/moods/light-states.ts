import type { LightCommand, LightState } from "@meetsanctum/app-sdk";

import type { Light, LightCapability } from "../targets.js";

// What a mood does with a room's lights, ported from v1
// (target-mood-commands.ts in the core, mood-settings.ts and mood-active.ts
// in web-nuxt, Pragmata v1-final). Moods' actions and its pages share it,
// so it imports nothing at run time.

/**
 * What a mood sets one light to: off, or on with the level and colour it
 * wants. It is the whole state rather than a change, since the core
 * remembers a light's level while it is off.
 */
export type MoodLightState =
  | { on: false }
  | {
      on: true;
      brightness?: number;
      colorTemperature?: number;
      hue?: number;
      saturation?: number;
    };

/** One light of a mood, by its device and capability. */
export type MoodLight = {
  device: string;
  capability: string;
  state: MoodLightState;
};

/**
 * What a preview sets one light to: as a mood does, or off with the level
 * and colour it comes back at. The core holds those for it, so a light the
 * preview turned on goes back off as it was rather than coming back as the
 * preview left it.
 */
export type PreviewLightState =
  | MoodLightState
  | ({ on: false } & Omit<Extract<MoodLightState, { on: true }>, "on">);

/** One light of a preview, by its device and capability. */
export type PreviewLight = Omit<MoodLight, "state"> & {
  state: PreviewLightState;
};

export const lightKey = (device: string, capability: string) =>
  `${device}/${capability}`;
export const keyOf = (light: Light) =>
  lightKey(light.device.id, light.capability.id);

/**
 * A light as it is now, as a mood keeps it (v1's moodActionStateFromEntity):
 * a command still on its way counts, and only what the light can do is
 * kept, its colour or its colour temperature, whichever it shows.
 */
export function captureLight(capability: LightCapability): MoodLightState {
  const { state, features } = capability;
  if (!state?.on) return { on: false };
  const captured: MoodLightState = { on: true };
  if (features.brightness) {
    captured.brightness = Math.max(1, state.brightness ?? 100);
  }
  const range = features.colorTemperature;
  if (
    features.color &&
    state.colorMode !== "temperature" &&
    state.hue !== undefined &&
    state.saturation !== undefined
  ) {
    captured.hue = state.hue;
    captured.saturation = state.saturation;
  } else if (
    range &&
    state.colorMode !== "color" &&
    state.colorTemperature !== undefined
  ) {
    captured.colorTemperature = Math.min(
      range.max,
      Math.max(range.min, state.colorTemperature),
    );
  }
  return captured;
}

/** The command that sets a light to a mood's or a preview's state. */
export function moodCommand(state: PreviewLightState): LightCommand {
  return { ...state };
}

/**
 * What running a mood in its room sends (v1's lightMoodCommandsForMood, the
 * target-portion rule): each of its lights in the room takes the mood's
 * state, and every other light in the room that is on turns off. Its
 * lights elsewhere are left alone, and a mood with none of its lights in
 * the room does nothing rather than turn the room off. A preview sends
 * the same.
 */
export function moodCommands(
  lights: readonly PreviewLight[],
  room: readonly Light[],
): { light: Light; command: LightCommand }[] {
  const byKey = new Map(room.map((light) => [keyOf(light), light]));
  const own = lights.flatMap((each) => {
    const light = byKey.get(lightKey(each.device, each.capability));
    return light ? [{ light, command: moodCommand(each.state) }] : [];
  });
  if (own.length === 0) return [];
  const covered = new Set(own.map(({ light }) => keyOf(light)));
  const off = room
    .filter((light) => !covered.has(keyOf(light)))
    .filter((light) => light.capability.state?.on === true)
    .map((light) => ({ light, command: { on: false } }));
  return [...own, ...off];
}

// How far a light may be from what a mood set and still show it (v1's
// tolerances): a level, hue or saturation within 2, a colour temperature
// within 15 mireds.
const tolerance = 2;
const temperatureTolerance = 15;

function near(actual: number | undefined, wanted: number | undefined) {
  return (
    wanted === undefined ||
    (actual !== undefined && Math.abs(actual - wanted) <= tolerance)
  );
}

// Hue goes round: 359 is next to 1.
function nearHue(actual: number | undefined, wanted: number | undefined) {
  if (wanted === undefined) return true;
  if (actual === undefined) return false;
  const apart = Math.abs(actual - wanted) % 360;
  return Math.min(apart, 360 - apart) <= tolerance;
}

/** Whether a light shows what a mood sets it to (v1's lightStateMatchesExpectation). */
export function showsState(state: LightState | null, wanted: MoodLightState) {
  if (!state || state.on !== wanted.on) return false;
  if (!wanted.on) return true;
  if (wanted.hue !== undefined && state.colorMode === "temperature")
    return false;
  if (wanted.colorTemperature !== undefined && state.colorMode === "color")
    return false;
  return (
    near(state.brightness, wanted.brightness) &&
    nearHue(state.hue, wanted.hue) &&
    near(state.saturation, wanted.saturation) &&
    (wanted.colorTemperature === undefined ||
      (state.colorTemperature !== undefined &&
        Math.abs(state.colorTemperature - wanted.colorTemperature) <=
          temperatureTolerance))
  );
}

/**
 * Whether a room's lights show a mood (v1's targetExpectationsMatch): each
 * of its lights in the room as it sets it, and every other light in the
 * room off. Like running it, a mood with none of its lights in the room
 * shows nowhere.
 */
export function showsMood(
  lights: readonly MoodLight[],
  room: readonly Light[],
): boolean {
  const wanted = new Map(
    lights.map((each) => [lightKey(each.device, each.capability), each.state]),
  );
  if (!room.some((light) => wanted.has(keyOf(light)))) return false;
  return room.every((light) =>
    showsState(
      light.capability.state,
      wanted.get(keyOf(light)) ?? { on: false },
    ),
  );
}

/**
 * The mood a room's lights show now (v1's resolveTargetActiveMoodId): the
 * one that matches, or none when no mood or more than one does.
 */
export function activeMood(
  moods: readonly { id: string; lights: readonly MoodLight[] }[],
  room: readonly Light[],
): string | null {
  const showing = moods.filter((mood) => showsMood(mood.lights, room));
  return showing.length === 1 ? showing[0]!.id : null;
}
