import { z } from "zod";

import { curveShapes, type CurveSettings } from "./curve.js";

// Natural light's settings: the curve, which Settings → Apps → Natural light
// shows and the app's page opens.
// Colour temperature runs from 2,000 to 6,500 K in steps of 100, brightness
// from 20 to 100 % in steps of 5, and sunrise and sunset offsets up to two
// hours in steps of 15 minutes. A light shows a colour temperature within
// its own range.

const kelvin = z.number().int().min(2000).max(6500).multipleOf(100);
const brightness = z.number().int().min(20).max(100).multipleOf(5);
const offset = z.number().int().min(-120).max(120).multipleOf(15);

export const naturalLightSettings = z.object({
  shape: z
    .enum(curveShapes)
    .default("balanced")
    .meta({
      title: "Curve",
      description:
        "When the curve peaks: at solar noon, or a third of the way into the day.",
      options: { balanced: "Balanced", early_riser: "Early riser" },
    }),
  lowKelvin: kelvin.default(2000).meta({
    title: "Colour temperature at night",
    description: "In kelvin, from sunset to sunrise. Lower is warmer.",
  }),
  highKelvin: kelvin.default(5500).meta({
    title: "Colour temperature at the peak",
    description: "In kelvin. Higher is cooler.",
  }),
  lowBrightness: brightness.default(80).meta({
    title: "Brightness at night",
    description: "In percent, from sunset to sunrise.",
  }),
  highBrightness: brightness.default(100).meta({
    title: "Brightness at the peak",
    description: "In percent.",
  }),
  sunriseOffsetMinutes: offset.default(0).meta({
    title: "Minutes after sunrise",
    description:
      "When the curve starts towards its peak; a negative number starts it before sunrise.",
  }),
  sunsetOffsetMinutes: offset.default(0).meta({
    title: "Minutes after sunset",
    description:
      "When the curve is back at night; a negative number ends it before sunset.",
  }),
}) satisfies z.ZodType<CurveSettings>;

/** The default curve, until the household changes it. */
export const defaultCurve: CurveSettings = naturalLightSettings.parse({});

/** The curve the household chose, from the app's settings (ctx.settings.get()). */
export const curveOf = (settings: unknown): CurveSettings =>
  naturalLightSettings.parse(settings);
