import { and, eq, sql } from "drizzle-orm";

import type { CoreDatabase } from "../database.js";
import { deviceCapabilities, devices } from "./schema.js";

// What the Devices module reads for every command and every report, each
// compiled once: SQLite compiling a statement costs far more than running
// it, and one press of a room's lights reads its devices dozens of times.

export function createDeviceReads(db: CoreDatabase) {
  const device = db
    .select()
    .from(devices)
    .where(eq(devices.id, sql.placeholder("id")))
    .prepare();
  const address = db
    .select({ driver: devices.driver, key: devices.key })
    .from(devices)
    .where(eq(devices.id, sql.placeholder("id")))
    .prepare();
  const byKey = db
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.driver, sql.placeholder("driver")),
        eq(devices.key, sql.placeholder("key")),
      ),
    )
    .prepare();
  const everyDevice = db.select().from(devices).prepare();
  const capabilities = db
    .select()
    .from(deviceCapabilities)
    .where(eq(deviceCapabilities.deviceId, sql.placeholder("id")))
    .prepare();
  const capability = db
    .select()
    .from(deviceCapabilities)
    .where(
      and(
        eq(deviceCapabilities.deviceId, sql.placeholder("device")),
        eq(deviceCapabilities.id, sql.placeholder("capability")),
      ),
    )
    .prepare();
  const everyCapability = db.select().from(deviceCapabilities).prepare();

  return {
    device: (id: string) => device.get({ id }),
    /** The driver app that brings a device, and that driver's own id for it. */
    address: (id: string) => address.get({ id }),
    /** A driver's device by the driver's own id for it. */
    byKey: (driver: string, key: string) => byKey.get({ driver, key }),
    everyDevice: () => everyDevice.all(),
    capabilities: (id: string) => capabilities.all({ id }),
    capability: (device: string, id: string) =>
      capability.get({ device, capability: id }),
    everyCapability: () => everyCapability.all(),
  };
}

export type DeviceReads = ReturnType<typeof createDeviceReads>;
