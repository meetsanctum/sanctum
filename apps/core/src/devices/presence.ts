import { devicePresence } from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import type { createDeviceLog } from "./activity.js";
import { devices } from "./schema.js";

// Which of a driver's devices its network still has: whenever a driver
// learns its network's whole list, as when it starts, it says which devices
// it has, and the rest have left it, as after a reset, even while the driver
// was not running. They are offline and marked as having left
// (DeviceInfo.leftAt), which Settings shows as not paired any more, until a
// list has them again or the driver registers them; the activity log says
// each left, once. One the core is removing is no news.

export function createPresence(
  db: CoreDatabase,
  options: {
    record: RecordActivity;
    deviceLog: ReturnType<typeof createDeviceLog>;
    // The devices being removed.
    removing: ReadonlySet<string>;
    // Runs a change, then tells live clients what it did to the device.
    changing: <T>(id: string, work: () => T) => T;
    now: () => Date;
  },
) {
  const { record, deviceLog, removing, changing } = options;

  return function present(driver: string, input: unknown) {
    const parsed = devicePresence.safeParse(input);
    if (!parsed.success) {
      throw new Error(
        `${driver} said which devices it has in a way the core cannot take: ${z.prettifyError(parsed.error)}`,
      );
    }
    const keys = new Set(parsed.data.keys);
    const at = options.now();
    for (const device of db
      .select({
        id: devices.id,
        key: devices.key,
        availability: devices.availability,
        leftAt: devices.leftAt,
      })
      .from(devices)
      .where(eq(devices.driver, driver))
      .all()) {
      const listed = keys.has(device.key);
      if (listed ? !device.leftAt : device.leftAt) continue;
      if (removing.has(device.id)) continue;
      changing(device.id, () =>
        db.transaction(() => {
          if (listed) {
            db.update(devices)
              .set({ leftAt: null })
              .where(eq(devices.id, device.id))
              .run();
            return;
          }
          db.update(devices)
            .set({ availability: "offline", leftAt: at })
            .where(eq(devices.id, device.id))
            .run();
          deviceLog.availability(device, "offline");
          record({
            action: "device.left",
            outcome: "ok",
            actor: "device",
            app: driver,
            subjectId: device.id,
          });
        }),
      );
    }
  };
}
