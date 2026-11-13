import {
  deviceTypeOf,
  type CapabilityKind,
  type DeviceType,
} from "@meetsanctum/app-sdk";

// What a device is, ported from v1's deriveDeviceType (classification.ts,
// Pragmata v1-final) for the core's typed capabilities: the first of the
// SDK's device types whose kinds it has. So it is a light if any of its
// capabilities is one, then a switch, which is a plug when its driver says
// it is one (v1's energy signals), then a button, as v1 called its
// remotes, then a motion sensor, which may measure too, then a sensor, and
// otherwise unknown. v1 sorted out diagnostic entities, such as battery and
// link quality, which never become capabilities here: a battery is the
// device's own (DeviceInfo.battery). Its categories are the shell's, by
// kind: lights, switches, environment for sensors, presence for motion
// sensors, and buttons; v1 put motion sensors under security, which is not
// one of them.

// What says a device is of a type its kinds do not tell: a whole word in
// what its driver calls it or in its model.
const signals: Partial<Record<DeviceType, RegExp>> = {
  plug: /\b(plugs?|outlets?|sockets?)\b/i,
};

export function deviceType(device: {
  // What its driver calls it, which for Zigbee is usually its model's name.
  driverName: string;
  model: string | null;
  capabilities: readonly { kind: CapabilityKind }[];
}): DeviceType {
  const called = `${device.driverName} ${device.model ?? ""}`;
  return deviceTypeOf(
    device.capabilities.map((each) => each.kind),
    (type) => signals[type]?.test(called) ?? false,
  );
}
