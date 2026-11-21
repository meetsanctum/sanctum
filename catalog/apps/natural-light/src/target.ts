import { defineEntityType } from "@meetsanctum/app-sdk";
import { z } from "zod";

// What natural light brings to the home: a `naturalLight.target` entity for
// each light that follows the curve, with the colour temperature and
// brightness it sets now, or that it is paused, or that natural light is
// switched off. It is the app's own type,
// for its pages, its widgets and the catalog.

export const targetStatuses = [
  "following",
  "dimmed",
  "paused",
  "waiting",
  "off",
] as const;

export const targetState = z.object({
  device: z.string(),
  capability: z.string(),
  /**
   * `following`: set to the curve, or brought back at it once switched on;
   * `dimmed`: on at a brightness someone set, its colour still on the
   * curve, until it is switched off or on;
   * `paused`: on, as a mood or a person set it, until it is switched off;
   * `waiting`: no curve today, until the home has a location and a sunrise
   * and sunset, or the light no longer takes a colour temperature;
   * `off`: natural light is switched off, so it keeps the look it has.
   */
  status: z.enum(targetStatuses),
  /** What it sets now, in mireds within the light's range; none while waiting or off. */
  colorTemperature: z.number().int().nullable(),
  /** Its brightness now, for a light that dims; none while dimmed, as it is someone else's. */
  brightness: z.number().int().min(0).max(100).nullable(),
});
export type TargetState = z.infer<typeof targetState>;

export const targetType = defineEntityType({
  id: "naturalLight.target",
  title: "Light following the sun",
  state: targetState,
  assistant: {
    starts: "on",
    description:
      "Each light that follows the sun, by its device and capability, with whether it is following, dimmed, paused, waiting or off, and the colour temperature and brightness natural light sets on it now.",
    needs: ["devices.control:light"],
  },
});

/** The entity's key: the light's device and capability. */
export const targetKey = (device: string, capability: string) =>
  `${device}/${capability}`;
