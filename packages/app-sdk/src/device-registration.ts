import { z } from "zod";

import { declaredTypes } from "./device-types.js";
import { capabilityRegistration, deviceKey } from "./devices.js";

// What a driver tells the core about one of its devices as it brings it in
// or updates it (ctx.devices.register): what it is called, what it is, what
// it can do and what it runs.

const label = z.string().trim().min(1).max(120);

/** What a driver tells the core about one of its devices (ctx.devices.register). */
export const deviceRegistration = z.strictObject({
  key: deviceKey,
  name: label,
  manufacturer: label.nullable().default(null),
  model: label.nullable().default(null),
  // What the device is: a type its driver may say (device-types.ts). The
  // driver decides, from what its protocol tells of the device; the core
  // takes its word once the device has what that type needs (fitsType).
  type: z.enum(declaredTypes),
  // What it can do, as capabilities of the kinds Sanctum has. A device
  // with none is one Sanctum cannot use: it is still the household's, to
  // name, put in a room and remove.
  capabilities: z
    .array(capabilityRegistration)
    .max(32)
    .refine(
      (list) => new Set(list.map((each) => each.id)).size === list.length,
      "capability ids must be unique",
    ),
  // What it runs, as its maker numbers it, whether the driver can update
  // it (driver.firmware), and whether it sleeps, so an update waits for it
  // to wake; none when the driver cannot tell.
  firmware: z
    .strictObject({
      version: label.nullable().default(null),
      updatable: z.boolean(),
      sleeps: z.boolean().default(false),
    })
    .nullable()
    .default(null),
  // Whether the driver can ask it how it is now (driver.probe): a device
  // that sleeps, or has nothing to read, cannot be asked.
  probe: z.boolean().default(false),
  // Whether the driver can have it show itself (driver.identify): a light
  // that blinks, or a device with a light of its own that is awake.
  identify: z.boolean().default(false),
});
export type DeviceRegistration = z.input<typeof deviceRegistration>;
