import type { ActionOutput, DeviceInfo } from "@meetsanctum/app-sdk";
import { lightColour, type Tile } from "@meetsanctum/ui-sdk";

import type { listMoods } from "../moods/actions.js";
import type { MoodIcon } from "../moods/icons.js";
import {
  captureLight,
  keyOf,
  lightKey,
  type MoodLight,
  type MoodLightState,
  type PreviewLight,
  type PreviewLightState,
} from "../moods/light-states.js";
import type { Light } from "../targets.js";

// The mood editor's draft, ported from v1's mood-settings.ts and
// mood-editor-dirty.ts (web-nuxt, Pragmata v1-final): each of the room's
// lights on or off, with the level and colour it has when on, kept while
// it is off so it comes back on as it was.

export type Mood = ActionOutput<typeof listMoods>[number];

type Look = Omit<Extract<MoodLightState, { on: true }>, "on">;

/** One light in the draft: whether the mood has it on, and how it looks when on. */
export type DraftLight = { on: boolean; look: Look };
export type Draft = ReadonlyMap<string, DraftLight>;

const editable = (light: Light) => light.device.availability !== "offline";

/** A room's lights as the editor shows them, those offline included, which it cannot set. */
export function roomLights(
  devices: readonly DeviceInfo[],
  roomId: string,
): Light[] {
  return devices
    .filter((device) => device.roomId === roomId)
    .flatMap((device) =>
      device.capabilities
        .filter((capability) => capability.kind === "light")
        .map((capability) => ({ device, capability })),
    )
    .sort(
      (a, b) =>
        a.device.name.localeCompare(b.device.name) ||
        a.capability.id.localeCompare(b.capability.id),
    );
}

const lookOf = (state: MoodLightState): Look => {
  if (!state.on) return {};
  const { on: _on, ...look } = state;
  return look;
};

// How a light looks when on: as now, or as it comes back on.
const currentLook = (light: Light) =>
  lookOf(
    captureLight({
      ...light.capability,
      state: { ...light.capability.state, on: true },
    }),
  );

/**
 * The draft with every light the editor can set, each it does not have yet
 * as it starts (v1's buildTargetMoodActions): for a new mood as the light
 * is, for a saved one as the mood sets it, off when the mood leaves it out.
 */
export function fillDraft(
  draft: Draft,
  lights: readonly Light[],
  mood?: Mood,
): Draft {
  const missing = lights
    .filter(editable)
    .filter((light) => !draft.has(keyOf(light)));
  if (missing.length === 0) return draft;
  const saved = new Map(
    mood?.lights.map((each) => [
      lightKey(each.device, each.capability),
      each.state,
    ]),
  );
  const filled = new Map(draft);
  for (const light of missing) {
    const state = mood
      ? (saved.get(keyOf(light)) ?? { on: false })
      : captureLight(light.capability);
    filled.set(
      keyOf(light),
      state.on
        ? { on: true, look: lookOf(state) }
        : { on: false, look: currentLook(light) },
    );
  }
  return filled;
}

/** A mood's state for a light as a draft light, as a smart mood's editor shows it. */
export const draftOf = (state: MoodLightState): DraftLight => ({
  on: state.on,
  look: lookOf(state),
});

/** A draft light as a mood sets it. */
export const moodState = (light: DraftLight): MoodLightState =>
  light.on ? { on: true, ...light.look } : { on: false };

/**
 * The mood's lights from the draft: each light the editor sets, and what
 * the saved mood has for lights it cannot show, such as one offline or
 * moved to another room (v1's preserved hidden actions).
 */
export function moodLightsOf(
  draft: Draft,
  lights: readonly Light[],
  mood?: Mood,
): MoodLight[] {
  const shown = lights.flatMap((light) => {
    const drafted = draft.get(keyOf(light));
    return drafted
      ? [
          {
            device: light.device.id,
            capability: light.capability.id,
            state: moodState(drafted),
          },
        ]
      : [];
  });
  const keys = new Set(
    shown.map((each) => lightKey(each.device, each.capability)),
  );
  const kept = (mood?.lights ?? []).filter(
    (each) => !keys.has(lightKey(each.device, each.capability)),
  );
  return [...shown, ...kept];
}

// A light as it is now, to put back: one that is off with the level and
// colour it comes back at, which a plain "off" would leave as the preview
// set them.
function earlierState(light: Light): PreviewLightState {
  const state = captureLight(light.capability);
  return state.on || !light.capability.state
    ? state
    : { on: false, ...currentLook(light) };
}

/**
 * What puts the lights back after a preview (v1's buildRestoreMoodActions):
 * each light as it was when the preview began, a light that turned up
 * later as it is now.
 */
export function restoreLights(
  lights: readonly Light[],
  earlier: readonly PreviewLight[] = [],
): PreviewLight[] {
  const restore = new Map(
    earlier.map((each) => [lightKey(each.device, each.capability), each]),
  );
  for (const light of lights.filter(editable)) {
    if (!restore.has(keyOf(light))) {
      restore.set(keyOf(light), {
        device: light.device.id,
        capability: light.capability.id,
        state: earlierState(light),
      });
    }
  }
  return [...restore.values()];
}

// A mood's lights in one form, whatever their order (v1's
// normalizeLightMoodStates). A light off and one left out are the same:
// running the mood turns both off.
function signature(lights: readonly MoodLight[]) {
  return JSON.stringify(
    lights
      .flatMap(({ device, capability, state }) =>
        state.on
          ? [
              [
                lightKey(device, capability),
                state.brightness ?? null,
                state.colorTemperature ?? null,
                state.hue ?? null,
                state.saturation ?? null,
              ],
            ]
          : [],
      )
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}

/** Whether saving the draft would change the saved mood (v1's mood-editor-dirty.ts). */
export function changes(
  mood: Mood | undefined,
  draft: { name: string; icon: MoodIcon; lights: readonly MoodLight[] },
) {
  return (
    !mood ||
    mood.name !== draft.name.trim() ||
    mood.icon !== draft.icon ||
    signature(mood.lights) !== signature(draft.lights)
  );
}

/** What a tile says of a draft light (v1's moodLightTileState): its level, and its colour or colour temperature. */
export function draftStatus(state: MoodLightState) {
  if (!state.on) return "Off";
  const parts = [
    state.brightness === undefined ? "On" : `${state.brightness}%`,
  ];
  if (state.hue !== undefined) parts.push("Colour");
  else if (state.colorTemperature !== undefined) {
    parts.push(`${Math.round(1_000_000 / state.colorTemperature)} K`);
  }
  return parts.join(" · ");
}

/** A room's light in the editor, as a tile showing what the draft sets it to. */
export function draftTile(light: Light, drafted: DraftLight | undefined): Tile {
  const { device, capability } = light;
  const several =
    device.capabilities.filter(
      (each) => each.kind === "light" || each.kind === "switch",
    ).length > 1;
  const base = {
    key: keyOf(light),
    deviceId: device.id,
    capabilityId: capability.id,
    kind: "light" as const,
    roomId: device.roomId,
    name: several ? `${device.name} ${capability.id}` : device.name,
  };
  if (!drafted || !editable(light)) {
    return {
      ...base,
      status: "Offline",
      on: false,
      look: "off",
      dims: false,
      disabled: true,
    };
  }
  const { look } = drafted;
  const state = moodState(drafted);
  return {
    ...base,
    status: draftStatus(state),
    on: drafted.on,
    look: drafted.on ? "lit" : "off",
    colour: lightColour({
      on: true,
      ...look,
      colorMode:
        look.hue !== undefined
          ? "color"
          : look.colorTemperature !== undefined
            ? "temperature"
            : undefined,
    }),
    dims: capability.features.brightness,
    brightness: look.brightness,
    disabled: false,
  };
}
