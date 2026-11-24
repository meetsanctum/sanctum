import {
  answersTo,
  attemptId,
  deviceProblemReport,
  isDeclaredRefusal,
  problemId,
  type Actor,
  type AttemptEnded,
  type DeviceAsking,
  type DeviceInfo,
  type DeviceProblem,
  type DeviceQuestion,
  type DriverCancelRepair,
  type DriverRepair,
  type DriverRepairResult,
} from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { ActivityAuthor, RecordActivity } from "../activity/activity.js";
import type { Outcome } from "../activity/schema.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Rule } from "../app-host/gate.js";
import type { CoreDatabase } from "../database.js";
import type { Asker, Asking, AskingFlow } from "./asking.js";
import type { Devices } from "./devices.js";
import { devices as deviceTable } from "./schema.js";
import type { Hold } from "./turns.js";

// What's wrong with a device, as its driver says in the words it declares,
// and Repair. The core keeps a problem with its device, through restarts,
// until the driver clears it or the device is removed, and Needs attention
// leads the device's row with it. Repair hands the driver the answers to what
// the problem's repair asks, once, for one device at a time: they reach no
// log, no activity entry and no live update, and a refusal comes back only as
// one the driver declares, so the field shows its words. A repair may ask once
// it has started, of the questions its problem declares for it (asking.ts):
// each answer then comes in a request of its own, naming the attempt.

// Repairing changes how a device is reached, never what it does, and can be
// done again.
export const repairRule: Rule = { tier: "write" };

const deviceId = z.string().min(1).max(64);

// Starting names the attempt where the client can answer what the repair
// asks once started; each later step names the step it answers, with the
// answers or a question to ask again.
export const repairRequest = z.union([
  z.strictObject({
    id: deviceId,
    answers: z.unknown().optional(),
    attempt: attemptId.optional(),
  }),
  z.strictObject({
    id: deviceId,
    attempt: attemptId,
    step: z.number().int().min(1).max(1_000),
    answers: z.unknown(),
  }),
  z.strictObject({
    id: deviceId,
    attempt: attemptId,
    step: z.number().int().min(1).max(1_000),
    again: z.string().regex(problemId),
  }),
]);

export const cancelRepairRequest = z.strictObject({
  id: deviceId,
  attempt: attemptId,
});

export type RepairDrivers = {
  /** Which run of a driver app takes calls now, or nothing while none does. */
  run(driver: string): number | undefined;
  repair(
    driver: string,
    repair: DriverRepair,
    actor: Actor,
    hold?: Hold,
    withinMs?: number,
  ): Promise<DriverRepairResult>;
  cancelRepair(
    driver: string,
    cancel: DriverCancelRepair,
    actor: Actor,
    hold?: Hold,
  ): Promise<void>;
  /** What repairing a problem may ask once started, of the version taking calls now. */
  laterOf(driver: string, problem: string): DeviceQuestion[];
};

/**
 * Where a repair got to: the device as it is now, the answer its driver
 * refused, what it asks next, or why it ended without either.
 */
export type RepairResult =
  | { repaired: DeviceInfo }
  | { refused: { question: string; refusal: string } }
  | DeviceAsking
  | AttemptEnded;

export function createProblems(options: {
  db: CoreDatabase;
  devices: Devices;
  drivers: RepairDrivers;
  asking: Asking;
  record: RecordActivity;
}) {
  const { db, devices, drivers, record, asking } = options;

  function log(
    id: string,
    outcome: Outcome,
    who: ActivityAuthor,
    reason?: string,
  ) {
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

    /**
     * For someone the gate has let through: sets the device right with
     * their answers, or takes the answer to what the repair asked once
     * started.
     */
    async repair(
      actor: Actor,
      who: Asker,
      input: unknown,
    ): Promise<RepairResult> {
      const parsed = repairRequest.safeParse(input);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      const request = parsed.data;
      const { id } = request;
      const device = devices.row(id);
      if (!device) {
        throw new ActionCallError("not_found");
      }
      if ("step" in request) {
        const result = await asking.next(device, who.clientId, request, actor);
        if (result === "gone") throw new ActionCallError("not_found");
        return "done" in result ? (result.done as RepairResult) : result;
      }
      return devices.turns.take(device, async (hold) => {
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
        const answers = answersTo(problem.repair.asks, request.answers ?? {});
        if (!answers) {
          log(id, "refused", who, "invalid_request");
          throw new ActionCallError("invalid_request");
        }
        const run = drivers.run(row.driver);
        if (run === undefined) {
          log(id, "refused", who, "unavailable");
          throw new ActionCallError("unavailable");
        }
        return asking.start(
          flowOf(
            id,
            row.driver,
            row.key,
            { ...problem, repair: problem.repair },
            run,
            who,
          ),
          {
            attempt: request.attempt,
            client: who.clientId,
            answers,
            asks: problem.repair.asks,
          },
          actor,
          hold,
        ) as Promise<RepairResult>;
      });
    },

    /** Ends the client's attempt to repair a device, as Cancel or the dialog closing asks. */
    async cancel(
      actor: Actor,
      who: Asker,
      input: unknown,
    ): Promise<AttemptEnded> {
      const parsed = cancelRepairRequest.safeParse(input);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      const device = devices.row(parsed.data.id);
      if (!device) {
        return { ended: "removed" };
      }
      return asking.cancel(device, who.clientId, parsed.data.attempt, actor);
    },
  };

  // What repairing a device does for the attempt that asks once started.
  function flowOf(
    id: string,
    driver: string,
    key: string,
    problem: DeviceProblem & { repair: NonNullable<DeviceProblem["repair"]> },
    run: number,
    who: ActivityAuthor,
  ): AskingFlow<RepairResult> {
    return {
      driver,
      key,
      run,
      later: drivers.laterOf(driver, problem.id),
      runNow: () => drivers.run(driver),
      call: (step, actor, hold, withinMs) =>
        drivers.repair(
          driver,
          { key, device: id, problem: problem.id, ...step },
          actor,
          hold,
          withinMs,
        ),
      finish(result, answered) {
        if (result !== undefined) {
          const parsed = z.object({ refused: z.unknown() }).safeParse(result);
          if (
            !parsed.success ||
            !isDeclaredRefusal(answered, parsed.data.refused)
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
      },
      failed(error) {
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
        return failure;
      },
      // The problem it repairs, still the device's.
      standing() {
        const row = devices.row(id);
        if (!row) return "removed";
        return row.problem?.id === problem.id ? null : "settled";
      },
      cancel: (attempt, actor, hold) =>
        drivers.cancelRepair(driver, { key, device: id, attempt }, actor, hold),
      refused: (refusal) => log(id, "refused", who, refusal),
    };
  }
}

export type Problems = ReturnType<typeof createProblems>;
