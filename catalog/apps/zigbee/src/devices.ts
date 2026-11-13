import type { DeviceRegistration } from "@meetsanctum/app-sdk";

import { capabilityMappings, type CapabilityMapping } from "./exposes.js";
import { versionOf } from "./firmware.js";
import type { ZigbeeDevice } from "./types.js";
import { stringValue } from "./values.js";

// Zigbee2MQTT's device list (`bridge/devices`) onto the devices the driver
// brings into the core. A device comes in once its interview has succeeded,
// with what it exposes that the core has a capability for: a light, a
// switch, buttons, a room's temperature, humidity or light level, or
// motion. One that exposes none of them, such as a repeater or an air
// purifier, comes in with no capabilities: the household has it on its
// network, and names, places and removes it like any device, though
// Sanctum cannot use it. The coordinator and disabled devices stay out, and
// so does a device whose interview failed (a ghost device), which
// Zigbee2MQTT knows nothing about.

export type ZigbeeDeviceEntry = {
  /** Its IEEE address, which outlives renames: the driver's key in the core. */
  key: string;
  /** Its name in Zigbee2MQTT, which names its topics. */
  friendlyName: string;
  /** A battery-powered device sleeps, so it often cannot be heard. */
  battery: boolean;
  capabilities: CapabilityMapping[];
  registration: DeviceRegistration;
};

const labelLength = 120;

function label(value: unknown) {
  const text = stringValue(value)?.trim().slice(0, labelLength).trim();
  return text || null;
}

/** Whether Zigbee2MQTT finished interviewing it, so its definition holds. */
export function isInterviewed(device: ZigbeeDevice) {
  const state = device.interview_state?.toLowerCase();
  return (
    device.interview_completed === true ||
    state === "successful" ||
    state === "success"
  );
}

/** What a device is, such as its model's name, while Zigbee2MQTT knows. */
export function descriptionOf(
  device: Pick<ZigbeeDevice, "definition"> & {
    model_id?: string;
  },
) {
  const vendorModel = [device.definition?.vendor, device.definition?.model]
    .filter((part) => stringValue(part))
    .join(" ");
  return (
    [device.definition?.description, vendorModel, device.model_id]
      .map(label)
      .find((each) => each !== null) ?? null
  );
}

// Zigbee2MQTT names a device by its IEEE address until someone renames it;
// what it is says more than that.
function nameOf(device: ZigbeeDevice, key: string, friendlyName: string) {
  return (
    (friendlyName.toLowerCase() === key.toLowerCase()
      ? descriptionOf({ definition: device.definition })
      : null) ??
    label(friendlyName) ??
    key
  );
}

// What the driver says a device is, where its capabilities do not: a plug,
// which switches like any switch. It is one when it switches, is no light,
// and a whole word in the name or model the driver registers says so, as
// Zigbee2MQTT's descriptions do: "TRADFRI control outlet", "Smart plug".
const plugWords = /\b(plugs?|outlets?|sockets?)\b/i;

function typeOf(
  capabilities: readonly CapabilityMapping[],
  name: string,
  model: string | null,
) {
  const kinds = new Set(capabilities.map((each) => each.kind));
  return kinds.has("switch") &&
    !kinds.has("light") &&
    plugWords.test(`${name} ${model ?? ""}`)
    ? ("plug" as const)
    : null;
}

// A capability as the core registers it: its kind's features, if it has any.
function registered(capability: CapabilityMapping) {
  const { id } = capability;
  switch (capability.kind) {
    case "light":
      return { id, kind: capability.kind, features: capability.features };
    case "button":
      return { id, kind: capability.kind, features: capability.features };
    case "sensor":
      return { id, kind: capability.kind, features: capability.features };
    case "occupancy":
      return { id, kind: capability.kind, features: capability.features };
    case "switch":
      return { id, kind: capability.kind };
  }
}

function entryOf(
  device: ZigbeeDevice,
  detectionIntervals: ReadonlyMap<string, number>,
): ZigbeeDeviceEntry | null {
  const key = label(device.ieee_address);
  const friendlyName = stringValue(device.friendly_name);
  if (
    !key ||
    !friendlyName ||
    device.type === "Coordinator" ||
    device.disabled === true ||
    !isInterviewed(device)
  ) {
    return null;
  }
  const capabilities = capabilityMappings(device.definition?.exposes ?? [], {
    model: stringValue(device.definition?.model),
    detectionInterval: detectionIntervals.get(key),
  });
  const battery = /battery/i.test(device.power_source ?? "");
  const name = nameOf(device, key, friendlyName);
  const model = label(device.definition?.model) ?? label(device.model_id);
  return {
    key,
    friendlyName,
    battery,
    capabilities,
    registration: {
      key,
      name,
      manufacturer:
        label(device.definition?.vendor) ?? label(device.manufacturer),
      model,
      type: typeOf(capabilities, name, model),
      capabilities: capabilities.map(registered),
      firmware: {
        version: versionOf(device),
        updatable: device.definition?.supports_ota === true,
        sleeps: battery,
      },
      // A sleeping device does not answer, and one with nothing to read
      // has nothing to say.
      probe: !battery && capabilities.some((each) => each.readable.length > 0),
    },
  };
}

/**
 * The devices in a `bridge/devices` message that the driver brings, with
 * the detection_interval each motion sensor last said, by key, which is
 * how long it is blind after it sees motion.
 */
export function deviceEntries(
  payload: unknown,
  detectionIntervals: ReadonlyMap<string, number> = new Map(),
): ZigbeeDeviceEntry[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const entries: ZigbeeDeviceEntry[] = [];
  for (const device of payload) {
    const entry =
      typeof device === "object" && device !== null
        ? entryOf(device as ZigbeeDevice, detectionIntervals)
        : null;
    if (entry && !entries.some((each) => each.key === entry.key)) {
      entries.push(entry);
    }
  }
  return entries;
}
