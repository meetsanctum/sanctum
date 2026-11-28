import {
  answersTo,
  attemptId,
  deviceKey,
  foundDevices,
  isDeclaredAddRefusal,
  problemId,
  type Actor,
  type AddResult,
  type DeviceQuestion,
  type DriverAdd,
  type DriverAddResult,
  type DriverCancelAdd,
  type FoundDevice,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import type { ActivityAuthor, RecordActivity } from "../activity/activity.js";
import type { Outcome } from "../activity/schema.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Rule } from "../app-host/gate.js";
import type { AddDone, Asker, Asking, AskingFlow } from "./asking.js";
import type { Devices } from "./devices.js";
import type { Hold } from "./turns.js";

// The devices drivers found and could add, and adding one. A driver lists all
// of them at once, and its list lasts as long as the run that said it: a
// driver that stops or restarts lists nothing until it says again. Add
// devices shows those the home doesn't have, each with what adding it asks in
// its driver's declared words. Adding hands the answers to driver.add once, in
// its turn with adding, repairing and removing the same device, and gives the
// driver a minute, as it may give the device its key first: it registers the
// device, then answers. Adding one the home has gives that device back. The
// answers reach no log, no activity entry and no live update, and a refusal
// comes back only as one the question declares. Adding may ask once it has
// started, of the questions the driver declares for it (asking.ts): each
// answer then comes in a request of its own, naming the client's attempt.

// Every client adds devices, shared ones too, as it lets them join; removing
// one undoes it.
export const addRule: Rule = { tier: "write" };

const device = { driver: z.string().min(1).max(128), key: deviceKey };

// Starting names the attempt where the client can answer what adding asks
// once started; each later step names the step it answers, with the answers
// or a question to ask again.
export const addRequest = z.union([
  z.strictObject({
    ...device,
    answers: z.unknown().optional(),
    attempt: attemptId.optional(),
  }),
  z.strictObject({
    ...device,
    attempt: attemptId,
    step: z.number().int().min(1).max(1_000),
    answers: z.unknown(),
  }),
  z.strictObject({
    ...device,
    attempt: attemptId,
    step: z.number().int().min(1).max(1_000),
    again: z.string().regex(problemId),
  }),
]);

export const cancelAddRequest = z.strictObject({
  ...device,
  attempt: attemptId,
});

export type AddDrivers = {
  /** Which run of a driver app takes calls now, or nothing while none does. */
  run(driver: string): number | undefined;
  add(
    driver: string,
    add: DriverAdd,
    actor: Actor,
    hold: Hold,
    withinMs: number | undefined,
    run: number,
  ): Promise<DriverAddResult>;
  cancelAdd(
    driver: string,
    cancel: DriverCancelAdd,
    actor: Actor,
    hold: Hold,
    run: number,
  ): Promise<void>;
  /** What adding may ask once started, of the version taking calls now. */
  laterOf(driver: string): DeviceQuestion[];
};

/** What the core knows of the driver that lists devices, from the version running. */
export type Lister = {
  run: number;
  canAdd: boolean;
  questionsOf: (ids: readonly string[]) => DeviceQuestion[];
  // What adding may ask once started, by id (driver.addLater).
  later: readonly string[];
  // Why it may refuse adding a device whatever it asks, by id, in its words.
  refusals: Record<string, string>;
};

export function createFound(options: {
  devices: Pick<Devices, "idFor" | "get" | "turns">;
  drivers: AddDrivers;
  asking: Asking;
  record: RecordActivity;
  // What Add devices shows may have changed.
  onChange: () => void;
}) {
  const { devices, drivers, record, asking } = options;
  const lists = new Map<string, { run: number; found: FoundDevice[] }>();

  function log(
    device: { name: string; id?: string },
    outcome: Outcome,
    who: ActivityAuthor,
    reason?: string,
  ) {
    record({
      action: "device.add",
      outcome,
      reason,
      personId: who.personId,
      clientId: who.clientId,
      subjectId: device.id,
      detail: { name: device.name },
    });
  }

  // A device a driver listed, while the run that listed it takes calls.
  function listed(driver: string, key: string) {
    const list = lists.get(driver);
    const found = list?.found.find((each) => each.key === key);
    if (!list || !found) {
      throw new ActionCallError("not_found");
    }
    if (drivers.run(driver) !== list.run) {
      throw new ActionCallError("unavailable");
    }
    return found;
  }

  return {
    /** What Add devices shows: what running drivers found that the home doesn't have. */
    list(): FoundDevice[] {
      return [...lists].flatMap(([driver, { run, found }]) =>
        drivers.run(driver) === run
          ? found.filter((each) => devices.idFor(driver, each.key) === null)
          : [],
      );
    },

    /**
     * A driver says which devices it could add, all of them, each asking only
     * questions it declares. One that cannot add devices lists none.
     */
    report(driver: string, input: unknown, lister: Lister) {
      const parsed = foundDevices.safeParse(input);
      if (!parsed.success) {
        throw new Error(
          `${driver} said something of the devices it found the core cannot take: ${z.prettifyError(parsed.error)}`,
        );
      }
      if (!lister.canAdd) {
        throw new Error(`${driver} lists devices it found but cannot add them`);
      }
      const found = parsed.data.map((each): FoundDevice => {
        const asks = lister.questionsOf(each.asks);
        if (asks.length !== each.asks.length) {
          throw new Error(
            `${driver} asks something of ${each.key} it doesn't declare`,
          );
        }
        return {
          driver,
          key: each.key,
          name: each.name,
          description: each.description,
          type: each.type,
          asks,
          later: [...lister.later],
          refusals: lister.refusals,
        };
      });
      lists.set(driver, { run: lister.run, found });
      options.onChange();
    },

    /**
     * For someone the gate has let through: adds a found device with their
     * answers, or takes the answer to what adding asked once started.
     */
    async add(actor: Actor, who: Asker, input: unknown): Promise<AddResult> {
      const parsed = addRequest.safeParse(input);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      const request = parsed.data;
      const { driver, key } = request;
      if ("step" in request) {
        const result = await asking.next(
          { driver, key },
          { operation: "add", driver, key },
          who.clientId,
          request,
          actor,
        );
        if (result === "gone") return addedOr(driver, key, "not_found");
        if (!("done" in result)) return result;
        if (result.operation !== "add") throw new ActionCallError("not_found");
        return result.done;
      }
      return devices.turns.take({ driver, key }, async (hold) => {
        // As it is once its turn comes: an add before may have added it.
        const had = devices.idFor(driver, key);
        const device = had ? devices.get(had) : null;
        if (device) return { added: device };
        const found = listed(driver, key);
        const answers = answersTo(found.asks, request.answers ?? {});
        if (!answers) {
          log(found, "refused", who, "invalid_request");
          throw new ActionCallError("invalid_request");
        }
        const result = await asking.start(
          flowOf(found, lists.get(driver)!.run, who),
          {
            attempt: request.attempt,
            client: who.clientId,
            answers,
            asks: found.asks,
          },
          actor,
          hold,
        );
        return "done" in result ? result.done : result;
      });
    },

    /**
     * Ends the client's attempt to add a found device, as its card's Cancel
     * or its closing asks. One that added the device in the meantime gives
     * the device.
     */
    async cancel(actor: Actor, who: Asker, input: unknown): Promise<AddResult> {
      const parsed = cancelAddRequest.safeParse(input);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      const { driver, key, attempt } = parsed.data;
      const ended = await asking.cancel(
        { driver, key },
        { operation: "add", driver, key },
        who.clientId,
        attempt,
        actor,
      );
      return addedOr(driver, key, ended);
    },
  };

  // The device where adding it got there in the meantime, else `otherwise`.
  function addedOr(
    driver: string,
    key: string,
    otherwise: "not_found" | AddResult,
  ): AddResult {
    const id = devices.idFor(driver, key);
    const device = id ? devices.get(id) : null;
    if (device) return { added: device };
    if (otherwise === "not_found") throw new ActionCallError("not_found");
    return otherwise;
  }

  // What adding a found device does for the attempt that asks once started.
  function flowOf(
    found: FoundDevice,
    run: number,
    who: ActivityAuthor,
  ): AskingFlow<{ operation: "add"; done: AddDone }> {
    const { driver, key } = found;
    return {
      target: { operation: "add", driver, key },
      driver,
      key,
      run,
      later: drivers.laterOf(driver),
      runNow: () => drivers.run(driver),
      call: (step, actor, hold, withinMs) =>
        drivers.add(driver, { key, ...step }, actor, hold, withinMs, run),
      finish(result, answered) {
        if (result !== undefined) {
          const said = z.object({ refused: z.unknown() }).safeParse(result);
          if (
            !said.success ||
            !isDeclaredAddRefusal(answered, found.refusals, said.data.refused)
          ) {
            log(found, "failed", who, "app_failed");
            throw new ActionCallError("app_failed");
          }
          const refused = said.data.refused;
          log(found, "refused", who, refused.refusal);
          return {
            operation: "add",
            done: {
              refused:
                "question" in refused
                  ? { question: refused.question, refusal: refused.refusal }
                  : { refusal: refused.refusal },
            },
          };
        }
        // It registers the device before it answers.
        const id = devices.idFor(driver, key);
        const added = id ? devices.get(id) : null;
        if (!id || !added) {
          log(found, "failed", who, "app_failed");
          throw new ActionCallError("app_failed");
        }
        log({ name: added.name, id }, "ok", who);
        return { operation: "add", done: { added } };
      },
      failed(error) {
        const failure =
          error instanceof ActionCallError
            ? error
            : new ActionCallError("app_failed");
        log(
          found,
          failure.status >= 500 ? "failed" : "refused",
          who,
          failure.code,
        );
        return failure;
      },
      standing: () => null,
      cancel: (attempt, actor, hold) =>
        drivers.cancelAdd(driver, { key, attempt }, actor, hold, run),
      refused: (refusal) => log(found, "refused", who, refusal),
    };
  }
}

export type Found = ReturnType<typeof createFound>;
