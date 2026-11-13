import {
  capabilityOf,
  type CapabilityInfo,
  type CapabilityKind,
  type DeviceInfo,
} from "@meetsanctum/app-sdk";

import { deviceType } from "./classification.js";
import type { deviceCapabilities, devices } from "./schema.js";
import { shownState } from "./sync.js";

// How a device is shown: what the core keeps of it, as DeviceInfo, and what
// each view of it holds.

type DeviceRow = typeof devices.$inferSelect;
type CapabilityRow = typeof deviceCapabilities.$inferSelect;

/**
 * What a device is shown with: every client sees every device, shared
 * clients too. Apps see the kinds they may read.
 */
export type View = { kinds?: ReadonlySet<CapabilityKind> };

/**
 * A device as one view sees it, or nothing when it sees none of it. A
 * client sees every device, one with no capabilities too, which the
 * household still names, places and removes. An app sees a device through
 * the kinds it may read, so it sees none of one that has no capabilities.
 */
export function viewOf(device: DeviceInfo, view: View = {}): DeviceInfo | null {
  const { kinds } = view;
  if (!kinds) return device;
  const capabilities = device.capabilities.filter((capability) =>
    kinds.has(capability.kind),
  );
  return capabilities.length ? { ...device, capabilities } : null;
}

// A capability's features with what its kind has added since its driver
// registered it, such as a button's holds, until the driver does again:
// a driver that is not running may never register it again.
function featuresOf(capability: CapabilityRow) {
  const parsed = capabilityOf(capability.kind).features.safeParse(
    capability.features,
  );
  return parsed.success ? parsed.data : capability.features;
}

/** A device and its capabilities as the core keeps them, for whoever may see all of it. */
export function deviceInfo(
  device: DeviceRow,
  capabilities: CapabilityRow[],
): DeviceInfo {
  return {
    id: device.id,
    name: device.name ?? device.driverName,
    driver: device.driver,
    manufacturer: device.manufacturer,
    model: device.model,
    roomId: device.roomId,
    driverName: device.driverName,
    type: deviceType({ ...device, capabilities }),
    availability: device.availability,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    firmware: device.firmware,
    probe: device.probe,
    battery: device.battery,
    leftAt: device.leftAt?.toISOString() ?? null,
    problem: device.problem ?? null,
    capabilities: capabilities
      .sort((a, b) => a.position - b.position)
      .map(
        (capability) =>
          ({
            id: capability.id,
            kind: capability.kind,
            features: featuresOf(capability),
            state: shownState(capability),
            observed: capability.observed,
            desired: capability.desired,
            sync: capability.sync,
            setBy: capability.setBy,
            changedAt: capability.changedAt?.toISOString() ?? null,
          }) as CapabilityInfo,
      ),
  };
}
