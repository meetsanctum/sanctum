import type { CapabilityKind } from "./devices.js";

// Where a device's parts show: the categories the sidebar lists, a room's
// page has a section for each of, and the home's status reports. A category
// holds capabilities, not devices, so a device shows wherever a part of it
// fits: a motion sensor that measures is under Presence and under
// Environment.

type DeviceCategoryDefinition = {
  id: string;
  /** Its name in the sidebar and above its section: "Lights". */
  title: string;
  /** The capabilities it holds, by their kind. */
  holds: readonly { kind: CapabilityKind }[];
};

const categories = [
  { id: "lights", title: "Lights", holds: [{ kind: "light" }] },
  { id: "switches", title: "Switches", holds: [{ kind: "switch" }] },
  { id: "environment", title: "Environment", holds: [{ kind: "sensor" }] },
  { id: "presence", title: "Presence", holds: [{ kind: "occupancy" }] },
  { id: "buttons", title: "Buttons", holds: [{ kind: "button" }] },
] as const satisfies readonly DeviceCategoryDefinition[];

/** A category of devices: one of the categories' ids. */
export type DeviceCategory = (typeof categories)[number]["id"];

/** Every category, in the order the sidebar and a room's page list them. */
export const deviceCategories: readonly (DeviceCategoryDefinition & {
  id: DeviceCategory;
})[] = categories;

/** The category that holds capabilities of a kind, if one does. */
export function deviceCategoryOf(kind: string) {
  return deviceCategories.find((category) =>
    category.holds.some((each) => each.kind === kind),
  );
}
