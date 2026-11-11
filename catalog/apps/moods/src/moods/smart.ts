import type { Light } from "../targets.js";
import type { MoodIcon } from "./icons.js";
import { keyOf, lightKey, type MoodLight } from "./light-states.js";
import type { Mood } from "./store.js";

// Smart moods, ported from v1 (smart-moods.ts and smart-moods/catalog.json
// in the core, Pragmata v1-final): a definition from Moods' catalog,
// assigned to a room with a brightness and the lights it leaves off. It
// works out each light's state from the room's lights as they are, so a
// light added to the room joins in. Moods' actions and its pages share
// it, so it imports nothing at run time.

export type SmartColour = { hue: number; saturation: number };

export type SmartDefinition = {
  /** Permanent: an assignment names it. v1's ids, kept as they were. */
  id: string;
  name: string;
  icon: MoodIcon;
  /** The brightness it starts at, 1 to 100. */
  brightness: number;
  /** One to five colours, handed out to the lights in turn. */
  colours: readonly SmartColour[];
};

export type SmartGroup = {
  id: string;
  name: string;
  moods: readonly SmartDefinition[];
};

/** The catalog, v1's own, its names in sentence case. */
export const smartCatalog: readonly SmartGroup[] = [
  {
    id: "color",
    name: "Colour",
    moods: [
      {
        id: "aurora",
        name: "Aurora",
        icon: "sparkles",
        brightness: 70,
        colours: [
          { hue: 190, saturation: 82 },
          { hue: 132, saturation: 88 },
          { hue: 300, saturation: 74 },
          { hue: 48, saturation: 88 },
        ],
      },
      {
        id: "crimson-pulse",
        name: "Crimson pulse",
        icon: "flame",
        brightness: 65,
        colours: [
          { hue: 348, saturation: 88 },
          { hue: 12, saturation: 84 },
          { hue: 318, saturation: 72 },
        ],
      },
      {
        id: "chromaluminescentdreamscape",
        name: "Chroma",
        icon: "palette",
        brightness: 65,
        colours: [
          { hue: 212, saturation: 90 },
          { hue: 276, saturation: 82 },
          { hue: 184, saturation: 76 },
          { hue: 52, saturation: 88 },
        ],
      },
      {
        id: "quiet-harbor",
        name: "Quiet harbour",
        icon: "waves",
        brightness: 53,
        colours: [
          { hue: 204, saturation: 44 },
          { hue: 178, saturation: 36 },
          { hue: 38, saturation: 42 },
        ],
      },
      {
        id: "circuit-bloom",
        name: "Circuit bloom",
        icon: "zap",
        brightness: 74,
        colours: [
          { hue: 132, saturation: 92 },
          { hue: 186, saturation: 88 },
          { hue: 82, saturation: 90 },
        ],
      },
    ],
  },
  {
    id: "calm",
    name: "Calm",
    moods: [
      {
        id: "late-night-library-warm-corners",
        name: "Library",
        icon: "book-open",
        brightness: 50,
        colours: [
          { hue: 32, saturation: 66 },
          { hue: 44, saturation: 52 },
          { hue: 18, saturation: 48 },
        ],
      },
    ],
  },
  {
    id: "energy",
    name: "Energy",
    moods: [
      {
        id: "morningsunshinethatneverquiteends",
        name: "Sunrise",
        icon: "sunrise",
        brightness: 76,
        colours: [
          { hue: 42, saturation: 90 },
          { hue: 58, saturation: 86 },
          { hue: 24, saturation: 78 },
        ],
      },
    ],
  },
];

export const smartDefinitions: readonly SmartDefinition[] =
  smartCatalog.flatMap((group) => group.moods);

/** A definition by its id (v1's smartMoodDefinition). */
export const smartDefinition = (id: string) =>
  smartDefinitions.find((definition) => definition.id === id);

/** What a room's smart mood was set to: its brightness and the lights it leaves off. */
export type SmartSettings = {
  brightness: number;
  off: { device: string; capability: string }[];
};

// v1's order: by name, then by id, so the same light takes the same colour
// each time.
const byName = (a: Light, b: Light) =>
  a.device.name.localeCompare(b.device.name) ||
  a.capability.id.localeCompare(b.capability.id) ||
  a.device.id.localeCompare(b.device.id);

/**
 * What a smart mood sets each of a room's lights to (v1's
 * smartMoodCommandsForDefinition): the lights it leaves off, off; the rest
 * on at its brightness, each taking the definition's colours in turn, by
 * name. A light that cannot show a colour takes only the brightness, and
 * one that cannot dim only turns on.
 */
export function smartLights(
  definition: SmartDefinition,
  settings: SmartSettings,
  room: readonly Light[],
): MoodLight[] {
  const off = new Set(
    settings.off.map((each) => lightKey(each.device, each.capability)),
  );
  const sorted = [...room].sort(byName);
  let index = 0;
  return sorted.map((light) => {
    const at = { device: light.device.id, capability: light.capability.id };
    if (off.has(keyOf(light))) return { ...at, state: { on: false } };
    const colour = definition.colours[index % definition.colours.length]!;
    index += 1;
    const { features } = light.capability;
    return {
      ...at,
      state: {
        on: true,
        ...(features.brightness ? { brightness: settings.brightness } : {}),
        ...(features.color
          ? { hue: colour.hue, saturation: colour.saturation }
          : {}),
      },
    };
  });
}

/** A mood's lights in its room: a smart mood's worked out from the room's lights as they are. */
export function lightsOf(mood: Mood, room: readonly Light[]): MoodLight[] {
  if (!mood.smart) return mood.lights;
  const definition = smartDefinition(mood.smart.definition);
  return definition ? smartLights(definition, mood.smart, room) : [];
}
