import { z } from "zod";

import { defineEntityType } from "./entities.js";

// The lights of a room, a floor, a zone, the whole home or chosen lights
// together: the core switches them for a room's, a floor's and Lights'
// button, and its lights condition and step ask about and switch them in
// workflows, so they work with no lighting app. The step also makes them brighter or dimmer, and
// brightens or dims them while a remote's button is held.

/** A room, a floor, a zone, the whole home, or chosen lights, whose lights go together. */
export type LightsPlace =
  | { kind: "room"; id: string }
  | { kind: "floor"; id: string }
  | { kind: "zone"; id: string }
  | { kind: "home" }
  | { kind: "lights"; lights: { device: string; capability: string }[] };

/** Toggling turns them all off while any is on, and on otherwise. */
export type LightsSwitch = "toggle" | "on" | "off";

/**
 * What the lights step does to a place's lights: switches them; steps their
 * brightness, brighter from off as from nothing, dimmer down to the lowest
 * but never off; or, while the remote's button that ran the workflow is
 * held, brightens them, from off at the lowest, or dims them to the lowest,
 * or each hold the other way from the last.
 */
export type LightsChange =
  | LightsSwitch
  | "brighter"
  | "dimmer"
  | "brightenWhileHeld"
  | "dimWhileHeld"
  | "brightenOrDimWhileHeld";

/**
 * What a place's lights are set to together, as a room's Lights tile and its
 * detail set them: a brightness, 0 for off; a colour temperature in mireds;
 * or a colour by its hue and saturation. Each light takes what it can.
 */
export type LightsSet =
  | {
      brightness: number;
      colorTemperature?: never;
      hue?: never;
      saturation?: never;
    }
  | {
      brightness?: never;
      colorTemperature: number;
      hue?: never;
      saturation?: never;
    }
  | {
      brightness?: never;
      colorTemperature?: never;
      hue: number;
      saturation: number;
    };

/**
 * What POST /api/devices/lights takes: the place's lights switched, or set
 * together.
 */
export type LightsRequest =
  | { place: LightsPlace; to: LightsSwitch; set?: never }
  | { place: LightsPlace; to?: never; set: LightsSet };

/** What switching a place's lights did. */
export type LightsResult = {
  /** Where the lights were switched to, or whether any is on after a step or a hold. */
  on: boolean;
  /** How many were sent a command or set moving. */
  switched: number;
  /** The lights that could not be switched, so a page can show which. */
  failed: { device: string; capability: string }[];
};

// What turning a room's lights on does: an app such as Moods publishes a
// lights.turnOn entity for a room, and the core reads it by type whenever it
// turns a room, a floor, a zone or the home on, so the rule stays the app's and no
// app code runs at the press. Several apps may each publish one for a room:
// the core goes by the highest-ranked (turnOnRanks). Each light it names
// stays off or comes on, with a look or as it remembers itself; a light it
// leaves out comes on as the core remembers it. A room with none comes on
// with every light at full brightness, unless the core holds a look for it.

/**
 * How firmly a rule holds, highest first: a choice the household made for
 * the room, such as a scheduled mood or turning it on as it was; a look an
 * app keeps for the room, such as natural light's; and what was on before
 * it went dark.
 */
export const turnOnRanks = ["chosen", "look", "previous"] as const;
export type TurnOnRank = (typeof turnOnRanks)[number];

const look = {
  brightness: z.number().int().min(1).max(100).optional(),
  colorTemperature: z.number().int().min(50).max(1000).optional(),
  hue: z.number().min(0).max(360).optional(),
  saturation: z.number().min(0).max(100).optional(),
};

const turnOnLightState = z.discriminatedUnion("on", [
  z.strictObject({ on: z.literal(false) }),
  z
    .strictObject({ on: z.literal(true), ...look })
    .refine(
      (state) => (state.hue === undefined) === (state.saturation === undefined),
      "hue and saturation go together",
    )
    .refine(
      (state) =>
        state.hue === undefined || state.colorTemperature === undefined,
      "a colour or a colour temperature, not both",
    ),
]);

export const turnOnSchema = z.object({
  /** The room it is for. */
  placeId: z.string().min(1),
  /** What its lights do when the room is turned on, by device and capability. */
  lights: z
    .array(
      z.strictObject({
        device: z.string().min(1),
        capability: z.string().min(1),
        state: turnOnLightState,
      }),
    )
    .max(200),
  /**
   * When it stops holding, such as a scheduled mood's end; the core goes by
   * none after it. Null holds until the app publishes another.
   */
  until: z.iso.datetime({ offset: true }).nullable(),
  /** How firmly it holds; a rule that says none is a choice. */
  rank: z.enum(turnOnRanks).default("chosen"),
});
export type TurnOn = z.infer<typeof turnOnSchema>;
export type TurnOnLight = TurnOn["lights"][number];

export const turnOnType = defineEntityType({
  id: "lights.turnOn",
  title: "Turning on",
  state: turnOnSchema,
  standard: true,
});
