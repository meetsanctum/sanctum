import type { CapabilityKind } from "@meetsanctum/app-sdk";

// What a device is, ported from v1's deriveDeviceType (classification.ts,
// Pragmata v1-final) for the core's typed capabilities: a light if any of
// its capabilities is one, then a switch, which is a plug when its driver
// says it is one (v1's energy signals), then a button, as v1 called its
// remotes, then a motion sensor, which may measure too, then a sensor, and
// otherwise just a device. v1 sorted out diagnostic entities, such as
// battery and link quality, which never become capabilities here: a battery
// is the device's own (DeviceInfo.battery). Its categories are the shell's,
// by kind: lights, switches, climate for sensors, motion, and buttons; v1
// put motion sensors under security, which is not one of them.

export type DeviceType =
  "light" | "plug" | "switch" | "button" | "motion" | "sensor" | "device";

const plugSignals = /\b(plugs?|outlets?|sockets?)\b/i;

export function deviceType(device: {
  // What its driver calls it, which for Zigbee is usually its model's name.
  driverName: string;
  model: string | null;
  capabilities: readonly { kind: CapabilityKind }[];
}): DeviceType {
  const kinds = new Set(device.capabilities.map((each) => each.kind));
  if (kinds.has("light")) {
    return "light";
  }
  if (kinds.has("switch")) {
    return plugSignals.test(`${device.driverName} ${device.model ?? ""}`)
      ? "plug"
      : "switch";
  }
  if (kinds.has("button")) {
    return "button";
  }
  if (kinds.has("occupancy")) {
    return "motion";
  }
  return kinds.has("sensor") ? "sensor" : "device";
}
