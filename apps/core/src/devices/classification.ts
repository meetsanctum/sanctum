import {
  deviceTypeOf,
  deviceTypes,
  shownType,
  type CapabilityKind,
  type DeviceType,
} from "@meetsanctum/app-sdk";

// What a device is. Its driver may say (declaredType), and is taken at its
// word when the device has the kinds that type needs: a driver knows its
// devices best, but cannot call a sensor a light. A type the device does
// not fit, one this core does not know, or one only the household can
// choose counts as not said.
//
// Otherwise it is the first of the SDK's device types whose kinds it has.
// So it is a light if any of its capabilities is one, then a switch, then a
// button, whatever else a remote has, then a motion sensor, which may
// measure too, then a sensor, and otherwise unknown. No capability tells a
// plug from a switch, so for a driver that says no type a switch is a plug
// when the driver calls it one: what a driver calls a device, usually its
// model's name, says "plug", "outlet" or "socket" of those that are.
//
// What a device says about itself, such as its battery and link quality,
// is no capability and plays no part: a battery is the device's own
// (DeviceInfo.battery). Where a device shows is not decided here: the
// shell's categories go by each capability's kind.
//
// The household may show it as another type its own type lists (shownAs),
// as a contact sensor as a door. Only the choice is kept: what the device
// is shown as is worked out here whenever it is read, so a choice that
// stops fitting is not used, and fits again when the device does.

// What says a device is of a type its kinds do not tell, when its driver
// says no type: a whole word in what the driver calls it or in its model.
const signals: Partial<Record<DeviceType, RegExp>> = {
  plug: /\b(plugs?|outlets?|sockets?)\b/i,
};

type Classified = {
  // What its driver calls it, which for Zigbee is usually its model's name.
  driverName: string;
  model: string | null;
  // The type its driver says it is, if it says one.
  declaredType?: string | null;
  capabilities: readonly { kind: CapabilityKind }[];
};

/** What a device is of itself, before what the household shows it as. */
export function ownDeviceType(device: Classified): DeviceType {
  const kinds = new Set(device.capabilities.map((each) => each.kind));
  const said = deviceTypes.find((type) => type.id === device.declaredType);
  if (said && !said.chosenOnly && said.needs.every((kind) => kinds.has(kind))) {
    return said.id;
  }
  const called = `${device.driverName} ${device.model ?? ""}`;
  return deviceTypeOf(kinds, (type) => signals[type]?.test(called) ?? false);
}

/** What a device is: what the household shows it as, or else its own type. */
export function deviceType(
  device: Classified & {
    // The type the household shows it as, if it chose one.
    shownAs?: string | null;
  },
): DeviceType {
  return shownType(ownDeviceType(device), device.shownAs);
}
