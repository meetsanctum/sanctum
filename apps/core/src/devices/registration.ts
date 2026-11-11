import { capabilityOf, type deviceRegistration } from "@meetsanctum/app-sdk";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type { CoreDatabase } from "../database.js";
import { deviceCapabilities } from "./schema.js";

type Registration = z.output<typeof deviceRegistration>;

/**
 * Writes the capabilities a driver registered for one of its devices. One
 * that keeps its kind keeps its state and what was asked of it, unless its
 * new features cannot carry that out; one whose kind changed starts afresh,
 * and what the device no longer has goes. `forget` drops what was asked of a
 * capability that loses it.
 */
export function writeCapabilities(
  db: CoreDatabase,
  id: string,
  capabilities: Registration["capabilities"],
  options: { at: Date; forget: (capability: string) => void },
) {
  const { at, forget } = options;
  const had = new Map(
    db
      .select()
      .from(deviceCapabilities)
      .where(eq(deviceCapabilities.deviceId, id))
      .all()
      .map((capability) => [capability.id, capability]),
  );
  for (const [position, capability] of capabilities.entries()) {
    const previous = had.get(capability.id);
    had.delete(capability.id);
    if (previous?.kind === capability.kind) {
      const hasUnsupportedTarget =
        previous.desired !== null &&
        !capabilityOf(capability.kind).supports(
          capability.features,
          previous.desired,
        );
      if (hasUnsupportedTarget) forget(capability.id);
      db.update(deviceCapabilities)
        .set({
          position,
          features: capability.features,
          updatedAt: at,
          ...(hasUnsupportedTarget
            ? {
                desired: null,
                sync: "conflict" as const,
                awaiting: null,
              }
            : {}),
        })
        .where(
          and(
            eq(deviceCapabilities.deviceId, id),
            eq(deviceCapabilities.id, capability.id),
          ),
        )
        .run();
      continue;
    }
    if (previous) {
      db.delete(deviceCapabilities)
        .where(
          and(
            eq(deviceCapabilities.deviceId, id),
            eq(deviceCapabilities.id, capability.id),
          ),
        )
        .run();
      forget(capability.id);
    }
    db.insert(deviceCapabilities)
      .values({
        deviceId: id,
        id: capability.id,
        kind: capability.kind,
        position,
        features: capability.features,
        sync: "synced",
        updatedAt: at,
      })
      .run();
  }
  // What the device no longer has goes.
  for (const gone of had.keys()) {
    db.delete(deviceCapabilities)
      .where(
        and(
          eq(deviceCapabilities.deviceId, id),
          eq(deviceCapabilities.id, gone),
        ),
      )
      .run();
    forget(gone);
  }
}
