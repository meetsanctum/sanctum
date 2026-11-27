import {
  deviceCategories,
  deviceCategoryOfType,
  type DeviceCategory,
  type DeviceInfo,
} from "@meetsanctum/app-sdk";

// Settings → Devices lists the home's devices by category, each in the one
// category of its type, so a motion sensor that measures is under Presence
// alone, and a device no category holds under Unknown Devices, last. Each
// group opens a page of its own with only its devices.

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

/** The group a device is listed in. */
export function deviceGroupOf(device: DeviceInfo): DeviceGroup {
  return deviceCategoryOfType(device.type)?.id ?? unknownGroup;
}

/** A group's title, the category's own, or none for an id it isn't. */
export function deviceGroupTitle(id: string | undefined): string | undefined {
  if (id === unknownGroup) return unknownDevicesTitle;
  return deviceCategories.find((category) => category.id === id)?.title;
}

/**
 * The groups that have devices, in the sidebar's order with Unknown
 * Devices last, each with its devices in the order given.
 */
export function deviceGroups(devices: readonly DeviceInfo[]) {
  const byGroup = new Map<DeviceGroup, DeviceInfo[]>();
  for (const device of devices) {
    const group = deviceGroupOf(device);
    const listed = byGroup.get(group);
    if (listed) listed.push(device);
    else byGroup.set(group, [device]);
  }
  const order: DeviceGroup[] = [
    ...deviceCategories.map((category) => category.id),
    unknownGroup,
  ];
  return order.flatMap((id) => {
    const listed = byGroup.get(id);
    return listed
      ? [{ id, title: deviceGroupTitle(id)!, devices: listed }]
      : [];
  });
}

/**
 * What a group's row says of it: how many of its devices need attention,
 * then how many others have an update, then how many it has.
 */
export function groupCounts(
  devices: readonly DeviceInfo[],
  needsAttention: (device: DeviceInfo) => boolean,
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
    count: `${devices.length} ${devices.length === 1 ? "device" : "devices"}`,
  };
}
