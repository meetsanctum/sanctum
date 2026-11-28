import {
  deviceCategories,
  deviceCategoryOfType,
  type DeviceCategory,
  type DeviceInfo,
  type DeviceType,
  type FoundDevice,
} from "@meetsanctum/app-sdk";

import { categoryOrder } from "./category-looks";

// Settings → Devices lists the home's devices by category, each in the one
// category of its type, so a motion sensor that measures is under Presence
// alone, and a device no category holds under Unknown Devices, last. Each
// group opens a page of its own with only its devices, and those found on
// the home's network that its app says are of that kind; one whose app
// doesn't say is under Unknown Devices until it's added.

/** The group of the devices no category holds. */
export const unknownGroup = "unknown";

/** A group of Settings → Devices: a category's id, or the unknown one. */
export type DeviceGroup = DeviceCategory | typeof unknownGroup;

export const unknownDevicesTitle = "Unknown Devices";

// What a group's devices are called in a sentence: "No motion sensors any
// more".
const nouns: Record<DeviceGroup, string> = {
  lights: "lights",
  switches: "switches",
  environment: "sensors",
  presence: "motion sensors",
  security: "contact sensors",
  media: "media players",
  buttons: "buttons",
  [unknownGroup]: "unknown devices",
};

/** What a group's devices are called in a sentence, or "devices". */
export function groupNoun(id: string | undefined) {
  return id && Object.hasOwn(nouns, id) ? nouns[id as DeviceGroup] : "devices";
}

export const upperFirst = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

/** The group a device of a type is listed in. */
function groupOfType(type: string | null): DeviceGroup {
  return (type && deviceCategoryOfType(type as DeviceType)?.id) || unknownGroup;
}

/** The group a device is listed in. */
export function deviceGroupOf(device: DeviceInfo): DeviceGroup {
  return groupOfType(device.type);
}

/** The group a device found on the network is listed in, by what its app says it is. */
export function foundGroupOf(found: Pick<FoundDevice, "type">): DeviceGroup {
  return groupOfType(found.type);
}

/** A group's title, the category's own, or none for an id it isn't. */
export function deviceGroupTitle(id: string | undefined): string | undefined {
  if (id === unknownGroup) return unknownDevicesTitle;
  return deviceCategories.find((category) => category.id === id)?.title;
}

/**
 * The groups that have devices or devices found, in the sidebar's order
 * with Unknown Devices last, each with its devices and what was found in
 * the order given.
 */
export function deviceGroups(
  devices: readonly DeviceInfo[],
  found: readonly FoundDevice[] = [],
) {
  const byGroup = new Map<
    DeviceGroup,
    { devices: DeviceInfo[]; found: FoundDevice[] }
  >();
  const of = (group: DeviceGroup) => {
    let listed = byGroup.get(group);
    if (!listed) {
      listed = { devices: [], found: [] };
      byGroup.set(group, listed);
    }
    return listed;
  };
  for (const device of devices) of(deviceGroupOf(device)).devices.push(device);
  for (const each of found) of(foundGroupOf(each)).found.push(each);
  const order = [...categoryOrder, unknownGroup] as const;
  return order.flatMap((id) => {
    const listed = byGroup.get(id);
    return listed ? [{ id, title: deviceGroupTitle(id)!, ...listed }] : [];
  });
}

/**
 * What a group's row says of it: how many of its devices need attention,
 * then how many others have an update, then how many were found to add,
 * then how many it has, where it has any.
 */
export function groupCounts(
  devices: readonly DeviceInfo[],
  needsAttention: (device: DeviceInfo) => boolean,
  found = 0,
) {
  let attention = 0;
  let updates = 0;
  for (const device of devices) {
    if (needsAttention(device)) attention += 1;
    else if (
      device.firmware?.state === "available" ||
      device.firmware?.state === "failed"
    )
      updates += 1;
  }
  return {
    attention: attention
      ? `${attention} ${attention === 1 ? "needs" : "need"} attention`
      : null,
    updates: updates
      ? `${updates} ${updates === 1 ? "update" : "updates"}`
      : null,
    found: found ? `${found} found` : null,
    count: devices.length
      ? `${devices.length} ${devices.length === 1 ? "device" : "devices"}`
      : null,
  };
}
