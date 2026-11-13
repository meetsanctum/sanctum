import {
  deviceTypeOf,
  type CapabilityKind,
  type DeviceType,
} from "@meetsanctum/app-sdk";

// What a device is: the first of the SDK's device types whose kinds it has.
// So it is a light if any of its capabilities is one, then a switch, then a
// button, whatever else a remote has, then a motion sensor, which may
// measure too, then a sensor, and otherwise unknown. A switch is a plug
// when its driver calls it one: no capability tells the two apart, and what
// a driver calls a device, usually its model's name, says "plug", "outlet"
// or "socket" of those that are. What a device says about itself, such as
// its battery and link quality, is no capability and plays no part: a
// battery is the device's own (DeviceInfo.battery). Where a device shows is
// not decided here: the shell's categories go by each capability's kind.

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
