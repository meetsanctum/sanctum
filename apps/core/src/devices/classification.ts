import { deviceTypes, shownType, type DeviceType } from "@meetsanctum/app-sdk";

// What a device is: what its driver says (declaredType), taken when the
// driver registers it once the device has what that type needs
// (driver-reports.ts). A driver knows its devices best, from what its
// protocol tells of them, so the core works nothing out itself. Every
// registration says a type; a stored device without one, or with one this
// build does not have, reads as unknown.
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

type Classified = {
  // The type its driver says it is.
  declaredType: string | null;
};

/** What a device is of itself, before what the household shows it as. */
export function ownDeviceType(device: Classified): DeviceType {
  return (
    deviceTypes.find(
      (type) => type.id === device.declaredType && !type.chosenOnly,
    )?.id ?? "unknown"
  );
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
