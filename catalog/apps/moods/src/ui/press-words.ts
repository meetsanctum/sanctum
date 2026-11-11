import type { DeviceInfo, Places } from "@meetsanctum/app-sdk";

import type { PressChoice, PressPlace, PressTo } from "../presses/presses.js";
import type { Mood } from "./mood-draft";
import { lightOptions } from "./press-lights";

// How the Presses page words what a press does: which lights, and what to do
// with them, as options read and as a press's line reads them.

/** What a press does to its lights, as its option reads. */
export const pressVerbs: Record<PressTo, string> = {
  on: "On",
  toggle: "On or off",
  off: "Off",
  brighter: "Brighter",
  dimmer: "Dimmer",
  brightenWhileHeld: "Brighten while held",
  dimWhileHeld: "Dim while held",
  brightenOrDimWhileHeld: "Brighten or dim while held",
};

/** What a press can do to its lights: a hold brightens or dims while held, a press steps. */
export function verbsFor(hold: boolean): PressTo[] {
  return hold
    ? [
        "on",
        "toggle",
        "off",
        "brightenWhileHeld",
        "dimWhileHeld",
        "brightenOrDimWhileHeld",
      ]
    : ["on", "toggle", "off", "brighter", "dimmer"];
}

/** What the verbs do that is not plain from their names. */
export function verbsNote(hold: boolean) {
  return hold
    ? "Brightening starts from off. Dimming stops at the lowest level and never switches a light off. Brighten or dim takes turns: each hold goes the other way."
    : "Brighter starts from off. Dimmer stops at the lowest level and never switches a light off.";
}

export function placeName(
  places: Places | undefined,
  kind: string,
  id: string,
  fallback = "Its",
) {
  const list = kind === "room" ? places?.rooms : places?.zones;
  return list?.find((each) => each.id === id)?.name ?? fallback;
}

// Chosen lights by their names: one or two named, more counted.
function chosenNames(
  lights: readonly { device: string; capability: string }[],
  devices: readonly DeviceInfo[],
) {
  if (lights.length > 2) return `${lights.length} lights`;
  const options = lightOptions(devices);
  const names = lights.map(
    (light) =>
      options.find(
        (each) =>
          each.device === light.device && each.capability === light.capability,
      )?.name ?? "A light",
  );
  return names.join(" and ");
}

/** Which lights, as the Which lights row reads it: Office, All lights, Desk lamp. */
export function placeLabel(
  place: PressPlace,
  places: Places | undefined,
  devices: readonly DeviceInfo[],
) {
  if (place.kind === "home") return "All lights";
  if (place.kind === "lights") return chosenNames(place.lights, devices);
  return placeName(places, place.kind, place.id, "Its room");
}

// The lights in a line, which a verb follows or comes before: "Office
// lights", "all lights", "Desk lamp and Shelf".
function lightsPhrase(
  place: PressPlace,
  places: Places | undefined,
  devices: readonly DeviceInfo[],
) {
  if (place.kind === "home") return "all lights";
  if (place.kind === "lights") return chosenNames(place.lights, devices);
  return `${placeName(places, place.kind, place.id)} lights`;
}

const capitalized = (text: string) =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** What a press does, in a line. */
export function describeChoice(
  choice: PressChoice | null,
  places: Places | undefined,
  devices: readonly DeviceInfo[],
  moods: readonly Mood[],
) {
  if (choice === null || choice.kind === "nothing") return "Nothing";
  if (choice.kind === "mood") {
    return moods.find((mood) => mood.id === choice.moodId)?.name ?? "A mood";
  }
  const lights = lightsPhrase(choice.place, places, devices);
  switch (choice.to) {
    case "on":
    case "off":
      return capitalized(`${lights} ${choice.to}`);
    case "toggle":
      return capitalized(`${lights} on or off`);
    case "brighter":
    case "dimmer":
      return capitalized(`${lights} ${choice.to}`);
    case "brightenWhileHeld":
      return `Brighten ${lights} while held`;
    case "dimWhileHeld":
      return `Dim ${lights} while held`;
    case "brightenOrDimWhileHeld":
      return `Brighten or dim ${lights} while held`;
  }
}

/** What the presses not chosen do, under the list. */
export function defaultsNote(
  defaults: { roomId: string; dimmer: boolean } | null,
  places: Places | undefined,
  hasHolds: boolean,
) {
  if (!defaults) return "Presses you haven't chosen do nothing.";
  const room = placeName(places, "room", defaults.roomId, "");
  if (defaults.dimmer) {
    return `Presses you haven't chosen work as a dimmer for ${room || "the room"}.`;
  }
  const lights = room ? `${room}'s lights` : "the room's lights";
  return hasHolds
    ? `Presses you haven't chosen switch ${lights} on or off, and a hold brightens or dims them.`
    : `Presses you haven't chosen switch ${lights} on or off.`;
}
