import type { CapabilityKind } from "./devices.js";

// What a device is, to the household: the word in its name, "Office motion
// sensor", and its icon in Settings. A capability kind says what one part
// of a device does; its type says what the whole device is, whatever driver
// brings it. A device is the first type in this order whose kinds it has,
// so a light that also measures is a light, and a motion sensor that
// measures is a motion sensor.

type DeviceTypeDefinition = {
  id: string;
  /** What a device's name calls it: "Office motion sensor". */
  noun: string;
  /** The capability kinds a device of this type has, each of them. */
  needs: readonly CapabilityKind[];
  /**
   * No capability tells it from the next type with its kinds, so a device
   * is one only where something else says so: the core reads a plug from
   * what its driver calls the device.
   */
  declaredOnly?: true;
};

const types = [
  { id: "light", noun: "light", needs: ["light"] },
  { id: "plug", noun: "plug", needs: ["switch"], declaredOnly: true },
  { id: "switch", noun: "switch", needs: ["switch"] },
  // A remote, whatever else it has.
  { id: "button", noun: "button", needs: ["button"] },
  // A motion sensor, which may measure too.
  { id: "motion", noun: "motion sensor", needs: ["occupancy"] },
  { id: "sensor", noun: "sensor", needs: ["sensor"] },
  // What none of the above fits.
  { id: "unknown", noun: "device", needs: [] },
] as const satisfies readonly DeviceTypeDefinition[];

/** What a device is: one of the types' ids. */
export type DeviceType = (typeof types)[number]["id"];

/** Every type of device, in the order a device is matched against them. */
export const deviceTypes: readonly (DeviceTypeDefinition & {
  id: DeviceType;
})[] = types;

/**
 * What a device with these capability kinds is: the first type whose kinds
 * it has. A type its kinds do not tell fits only where `declared` says the
 * device is one.
 */
export function deviceTypeOf(
  kinds: Iterable<CapabilityKind>,
  declared: (type: DeviceType) => boolean = () => false,
): DeviceType {
  const has = new Set(kinds);
  const type = deviceTypes.find(
    (each) =>
      each.needs.every((kind) => has.has(kind)) &&
      (!each.declaredOnly || declared(each.id)),
  );
  // The last type needs nothing, so one always fits.
  return type?.id ?? "unknown";
}
