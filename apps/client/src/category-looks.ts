import type { DeviceCategory } from "@meetsanctum/app-sdk";
import { icons, type LucideIcon } from "@meetsanctum/ui-sdk";

/**
 * A category's icon and colour, for each the SDK lists: the same in the
 * sidebar, on a category's page and in Settings → Devices.
 */
export const categoryLooks: Record<
  DeviceCategory,
  { icon: LucideIcon; colour: string }
> = {
  lights: { icon: icons.Lightbulb, colour: "var(--sun-text)" },
  switches: { icon: icons.Plug, colour: "var(--ember-text)" },
  environment: { icon: icons.Thermometer, colour: "var(--sky-text)" },
  presence: { icon: icons.Footprints, colour: "var(--leaf-text)" },
  // An open window is a fact and no warning, so Security is never red.
  security: { icon: icons.Shield, colour: "var(--iris-text)" },
  media: { icon: icons.TvMinimalPlay, colour: "var(--blossom-text)" },
  buttons: { icon: icons.CircleDot, colour: "var(--graphite-text)" },
};
