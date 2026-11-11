import { defineEntityType } from "@meetsanctum/app-sdk";
import { z } from "zod";

// What natural light brings to the home: a `naturalLight.target` entity for
// each light that follows the curve, with the colour temperature and
// brightness it sets now, or that it is paused. It is the app's own type,
// for its pages, its widgets and the catalog.

export const targetStatuses = ["following", "paused", "waiting"] as const;

export const targetState = z.object({
  device: z.string(),
  capability: z.string(),
  /**
   * `following`: set to the curve, or brought back at it once switched on;
   * `paused`: on, as a mood or a person set it, until it is switched off;
   * `waiting`: no curve today, until the home has a location and a sunrise
   * and sunset, or the light no longer takes a colour temperature.
   */
  status: z.enum(targetStatuses),
  /** What it sets now, in mireds within the light's range; none while waiting. */
  colorTemperature: z.number().int().nullable(),
  /** Its brightness now, for a light that dims. */
  brightness: z.number().int().min(0).max(100).nullable(),
});
export type TargetState = z.infer<typeof targetState>;

export const targetType = defineEntityType({
  id: "naturalLight.target",
  title: "Light following the sun",
  state: targetState,
});

/** The entity's key: the light's device and capability. */
export const targetKey = (device: string, capability: string) =>
  `${device}/${capability}`;
