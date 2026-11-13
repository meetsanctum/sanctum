import {
  deviceProblemReport,
  isDeclaredRefusal,
  repairAnswers,
  type Actor,
  type DeviceInfo,
  type DeviceProblem,
  type DriverRepair,
  type DriverRepairResult,
} from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { RecordActivity } from "../activity/activity.js";
import type { Outcome } from "../activity/schema.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Rule } from "../app-host/gate.js";
import type { CoreDatabase } from "../database.js";
import type { Who } from "./activity.js";
import type { Devices } from "./devices.js";
import { devices as deviceTable } from "./schema.js";

// What's wrong with a device, as its driver says in the words it declares,
// and Repair. The core keeps a problem with its device, through restarts,
// until the driver clears it or the device is removed, and Needs attention
// leads the device's row with it. Repair hands the driver the answers to what
// the problem's repair asks, once, for one device at a time: they reach no
// log, no activity entry and no live update, and a refusal comes back only as
// one the driver declares, so the field shows its words.

// Repairing changes how a device is reached, never what it does, and can be
// done again.
export const repairRule: Rule = { tier: "write" };

export const repairRequest = z.object({
  id: z.string().min(1).max(64),
  answers: z.unknown().optional(),
});

export type RepairDrivers = {
  repair(
    driver: string,
    repair: DriverRepair,
    actor: Actor,
  ): Promise<DriverRepairResult>;
};

/** How a repair ended: the device as it is now, or the answer its driver refused. */
export type RepairResult =
  { repaired: DeviceInfo } | { refused: { question: string; refusal: string } };

export function createProblems(options: {
  db: CoreDatabase;
  devices: Devices;
  drivers: RepairDrivers;
  record: RecordActivity;
}) {
  const { db, devices, drivers, record } = options;

  function log(id: string, outcome: Outcome, who: Who, reason?: string) {
    record({
      action: "device.repair",
      outcome,
      reason,
      personId: who.personId,
      clientId: who.clientId,
      subjectId: id,
      detail: { name: devices.get(id)?.name ?? null },
    });
  }

  return {
    /**
     * A driver says what's wrong with one of its devices, one of the
     * problems its manifest declares as `problemOf` finds it, or that
     * nothing is. One it doesn't declare is its mistake.
     */
    report(
      driver: string,
      input: unknown,
      problemOf: (id: string) => DeviceProblem | null,
    ) {
      const parsed = deviceProblemReport.safeParse(input);
      if (!parsed.success) {
        throw new Error(
          `${driver} said something of a device's problem the core cannot take: ${z.prettifyError(parsed.error)}`,
        );
      }
      const { key, problem: named } = parsed.data;
      const problem = named === null ? null : problemOf(named);
      if (named !== null && !problem) {
        throw new Error(`${driver} declares no problem ${named}`);
      }
      const id = devices.idFor(driver, key);
      const row = id ? devices.row(id) : null;
      if (!id || !row) {
        throw new ActionCallError("not_found");
      }
      if (JSON.stringify(row.problem ?? null) === JSON.stringify(problem)) {
        return;
      }
      devices.changing(id, () =>
        db
          .update(deviceTable)
          .set({ problem })
          .where(eq(deviceTable.id, id))
          .run(),
      );
      if (problem && row.problem?.id !== problem.id) {
        record({
          action: "device.problem",
          outcome: "ok",
          actor: "device",
          app: driver,
          subjectId: id,
          detail: {
            name: devices.get(id)?.name ?? null,
            problem: problem.words,
          },
        });
      }
    },

    /** For someone the gate has let through: sets the device right with their answers. */
    async repair(
      actor: Actor,
      who: Who,
      input: unknown,
    ): Promise<RepairResult> {
      const parsed = repairRequest.safeParse(input);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      const { id } = parsed.data;
      if (!devices.row(id)) {
        throw new ActionCallError("not_found");
      }
      return devices.turns.take(id, async () => {
        // As it is once its turn comes: a repair before may have set it right.
        const row = devices.row(id);
        if (!row) {
          throw new ActionCallError("not_found");
        }
        const problem = row.problem;
        if (!problem?.repair) {
          log(id, "refused", who, "conflict");
          throw new ActionCallError("conflict");
        }
        const answers = repairAnswers(problem, parsed.data.answers ?? {});
        if (!answers) {
          log(id, "refused", who, "invalid_request");
          throw new ActionCallError("invalid_request");
        }
        let result: unknown;
        try {
          result = await drivers.repair(
            row.driver,
            { key: row.key, device: id, problem: problem.id, answers },
            actor,
          );
        } catch (error) {
          const failure =
            error instanceof ActionCallError
              ? error
              : new ActionCallError("app_failed");
          log(
            id,
            failure.status >= 500 ? "failed" : "refused",
            who,
            failure.code,
          );
          throw failure;
        }
        if (result !== undefined) {
          const parsed = z.object({ refused: z.unknown() }).safeParse(result);
          if (
            !parsed.success ||
            !isDeclaredRefusal(problem, parsed.data.refused)
          ) {
            log(id, "failed", who, "app_failed");
            throw new ActionCallError("app_failed");
          }
          const { question, refusal } = parsed.data.refused;
          log(id, "refused", who, refusal);
          return { refused: { question, refusal } };
        }
        log(id, "ok", who);
        return { repaired: devices.get(id)! };
      });
    },
  };
}

export type Problems = ReturnType<typeof createProblems>;
