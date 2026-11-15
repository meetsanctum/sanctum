import {
  ActionError,
  capabilityOf,
  deviceRegistration,
  deviceReport,
  historyFields,
  type CapabilityKind,
} from "@meetsanctum/app-sdk";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import type { createDeviceLog } from "./activity.js";
import type { createCommandTracking } from "./commands.js";
import { unknownFirmware } from "./firmware.js";
import type { createNaming } from "./naming.js";
import { writeCapabilities } from "./registration.js";
import { deviceCapabilities, devices } from "./schema.js";
import { observe, reconcile } from "./sync.js";

// What a driver says of its own devices, by its own keys: one it brings in
// or updates, and what one of them said. Each goes through `changing`, so
// whoever follows devices hears of it once it has committed.

type CapabilityRow = typeof deviceCapabilities.$inferSelect;

// Whether a report changes what a capability says, by its kind's history
// fields (CapabilityInfo.changedAt): its first report does.
function changedFields(
  capability: {
    kind: CapabilityKind;
    observed: Record<string, unknown> | null;
  },
  observed: Record<string, unknown>,
) {
  return (
    capability.observed === null ||
    historyFields[capability.kind].some(
      (field: string) => capability.observed![field] !== observed[field],
    )
  );
}

function invalid(what: string, error: z.ZodError) {
  return new Error(`${what}: ${z.prettifyError(error)}`);
}

export function createDriverReports(
  db: CoreDatabase,
  options: {
    record: RecordActivity;
    deviceLog: ReturnType<typeof createDeviceLog>;
    commands: ReturnType<typeof createCommandTracking>;
    // One of a device's capabilities, if this build has its kind.
    capabilityRow: (
      deviceId: string,
      capabilityId: string,
    ) => CapabilityRow | undefined;
    // Runs a change, then tells live clients what it did to the device.
    changing: <T>(id: string, work: () => T) => T;
    // Names a device again after its room and what it is (naming.ts).
    rename: ReturnType<typeof createNaming>["rename"];
    // Called after a device's report has committed: it answered.
    onReport?: (id: string) => void;
    now: () => Date;
  },
) {
  const { record, deviceLog, commands, capabilityRow, changing, rename, now } =
    options;

  return {
    // A driver brings one of its devices in, or updates it, by its own key.
    register(driver: string, input: unknown): { id: string } {
      const parsed = deviceRegistration.safeParse(input);
      if (!parsed.success) {
        throw invalid(
          `${driver} registered a device the core cannot take`,
          parsed.error,
        );
      }
      const registration = parsed.data;
      const existing = db
        .select({ id: devices.id, firmware: devices.firmware })
        .from(devices)
        .where(
          and(eq(devices.driver, driver), eq(devices.key, registration.key)),
        )
        .get();
      const id = existing?.id ?? randomUUID();
      changing(id, () =>
        db.transaction(() => {
          const at = now();
          const described = {
            driverName: registration.name,
            manufacturer: registration.manufacturer,
            model: registration.model,
            declaredType: registration.type,
            // What an update is doing outlives the driver saying again
            // what the device runs.
            firmware: registration.firmware && {
              ...(existing?.firmware ?? unknownFirmware),
              ...registration.firmware,
            },
            probe: registration.probe,
            // A device its driver registers is on its network.
            leftAt: null,
            updatedAt: at,
          };
          if (existing) {
            db.update(devices).set(described).where(eq(devices.id, id)).run();
          } else {
            db.insert(devices)
              .values({
                id,
                driver,
                key: registration.key,
                ...described,
                autoNamed: true,
                availability: "unknown",
                createdAt: at,
              })
              .run();
            record({ action: "device.register", outcome: "ok", subjectId: id });
          }
          writeCapabilities(db, id, registration.capabilities, {
            at,
            forget: (capability) => commands.forget(id, capability),
          });
          // What it is may have changed with its capabilities, or with
          // what its driver says it is.
          rename(id);
        }),
      );
      return { id };
    },

    // A driver reports what one of its own devices said, by its own key.
    report(driver: string, input: unknown) {
      const parsed = deviceReport.safeParse(input);
      if (!parsed.success) {
        throw invalid(
          `${driver} sent a report the core cannot take`,
          parsed.error,
        );
      }
      const { key, availability, states = {}, battery } = parsed.data;
      const device = db
        .select()
        .from(devices)
        .where(and(eq(devices.driver, driver), eq(devices.key, key)))
        .get();
      if (!device) {
        throw new ActionError("not_found", `${driver} has no device ${key}`);
      }
      const observations = Object.entries(states).map(
        ([capabilityId, state]) => {
          const capability = capabilityRow(device.id, capabilityId);
          if (!capability) {
            throw new ActionError(
              "not_found",
              `${driver}'s device ${key} has no capability ${capabilityId}`,
            );
          }
          const observed = capabilityOf(capability.kind).state.safeParse(state);
          if (!observed.success) {
            throw invalid(
              `${driver} reported a ${capability.kind} state the core cannot take`,
              observed.error,
            );
          }
          return {
            capability,
            observed: observed.data as Record<string, unknown>,
          };
        },
      );
      const answered =
        observations.length > 0 ||
        battery !== undefined ||
        availability === "online";
      changing(device.id, () =>
        db.transaction(() => {
          const at = now();
          for (const { capability, observed: reported } of observations) {
            const observed = observe(capability, reported);
            deviceLog.reported(
              device.id,
              capability,
              observed,
              at,
              commands.sentAt(device.id, capability.id),
            );
            const settled = reconcile(capability, observed);
            db.update(deviceCapabilities)
              .set({
                observed,
                ...settled,
                awaiting: settled.awaiting ?? null,
                ...(changedFields(capability, observed) && { changedAt: at }),
                updatedAt: at,
              })
              .where(
                and(
                  eq(deviceCapabilities.deviceId, device.id),
                  eq(deviceCapabilities.id, capability.id),
                ),
              )
              .run();
            commands.reported(device.id, capability.id, capability, observed);
          }
          // One its network no longer has stays offline until a list has it
          // again or its driver registers it, whatever a late report says.
          const left = device.leftAt !== null;
          if (battery !== undefined) deviceLog.battery(device, battery, at);
          db.update(devices)
            .set({
              availability: left
                ? "offline"
                : (availability ?? device.availability),
              lastSeenAt: answered ? at : device.lastSeenAt,
              battery: battery ?? device.battery,
            })
            .where(eq(devices.id, device.id))
            .run();
          if (availability && !left) {
            deviceLog.availability(device, availability);
          }
        }),
      );
      if (answered) options.onReport?.(device.id);
    },
  };
}
