import type { Actor, DriverRemoval } from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Activity } from "../activity/activity.js";
import type { Outcome } from "../activity/schema.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Rule } from "../app-host/gate.js";
import type { CoreDatabase } from "../database.js";
import type { Who } from "./activity.js";
import { deviceCapabilities, devices } from "./schema.js";

// Removing a device: its driver takes it off its network, then the core
// forgets it, what it was asked included. A device whose driver is not
// running can only be forgotten by force; it comes back if the driver still
// has it then.

/** Has the driver app that brings a device take it off its network. */
export type RemoveFromDriver = (
  driver: string,
  removal: DriverRemoval,
  actor: Actor,
) => Promise<void>;

// Removing a device cannot be undone from Sanctum, since the device has to
// join again.
export const removalRule: Rule = { tier: "destructive" };

export const removalRequest = z.object({
  id: z.string().min(1).max(64),
  // Forget it even if its driver cannot take it off its network.
  force: z.boolean().default(false),
});

export function createRemoval(
  db: CoreDatabase,
  options: {
    record: ReturnType<Activity["for"]>;
    removeFromDriver?: RemoveFromDriver;
    // Its name now, for its entry once it is gone.
    nameOf: (id: string) => string | null;
    // Runs a change, then tells live clients what it did to the device.
    changing: (id: string, work: () => void) => void;
    // Drops what was asked of one of its capabilities.
    forget: (id: string, capability: string) => void;
  },
) {
  const { record, changing, forget } = options;
  // The devices being removed. Their driver may say it no longer has one
  // before the core forgets it, which is no news.
  const removing = new Set<string>();

  return {
    // Their driver may say they are gone before the core forgets them
    // (presence.ts).
    removing: removing as ReadonlySet<string>,

    // For someone the gate has let through.
    async remove(actor: Actor, who: Who, input: unknown): Promise<void> {
      const parsed = removalRequest.safeParse(input);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      const { id, force } = parsed.data;
      const device = db.select().from(devices).where(eq(devices.id, id)).get();
      if (!device) {
        throw new ActionCallError("not_found");
      }
      const name = options.nameOf(id);
      const log = (outcome: Outcome, reason?: string) =>
        record({
          action: "device.remove",
          outcome,
          reason,
          personId: who.personId,
          clientId: who.clientId,
          subjectId: id,
          detail: { name },
        });
      removing.add(id);
      try {
        if (!options.removeFromDriver) {
          throw new ActionCallError("unavailable");
        }
        await options.removeFromDriver(
          device.driver,
          { key: device.key, device: id, force },
          actor,
        );
      } catch (error) {
        const failure =
          error instanceof ActionCallError
            ? error
            : new ActionCallError("app_failed");
        if (!force || failure.code !== "unavailable") {
          log(failure.status >= 500 ? "failed" : "refused", failure.code);
          throw failure;
        }
      } finally {
        // Nothing runs between here and forgetting it.
        removing.delete(id);
      }
      changing(id, () => {
        for (const capability of db
          .select({ id: deviceCapabilities.id })
          .from(deviceCapabilities)
          .where(eq(deviceCapabilities.deviceId, id))
          .all()) {
          forget(id, capability.id);
        }
        db.delete(devices).where(eq(devices.id, id)).run();
      });
      log("ok");
    },
  };
}
