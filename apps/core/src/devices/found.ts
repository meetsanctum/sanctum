import {
  answersTo,
  deviceKey,
  foundDevices,
  isDeclaredAddRefusal,
  type Actor,
  type AddResult,
  type DeviceQuestion,
  type DriverAdd,
  type DriverAddResult,
  type FoundDevice,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import type { ActivityAuthor, RecordActivity } from "../activity/activity.js";
import type { Outcome } from "../activity/schema.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Rule } from "../app-host/gate.js";
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
// comes back only as one the question declares.

// Every client adds devices, shared ones too, as it lets them join; removing
// one undoes it.
export const addRule: Rule = { tier: "write" };

export const addRequest = z.object({
  driver: z.string().min(1).max(128),
  key: deviceKey,
  answers: z.unknown().optional(),
});

export type AddDrivers = {
  /** Which run of a driver app takes calls now, or nothing while none does. */
  run(driver: string): number | undefined;
  add(
    driver: string,
    add: DriverAdd,
    actor: Actor,
    hold?: Hold,
  ): Promise<DriverAddResult>;
};

/** What the core knows of the driver that lists devices, from the version running. */
export type Lister = {
  run: number;
  canAdd: boolean;
  questionsOf: (ids: readonly string[]) => DeviceQuestion[];
  // Why it may refuse adding a device whatever it asks, by id, in its words.
  refusals: Record<string, string>;
};

export function createFound(options: {
  devices: Pick<Devices, "idFor" | "get" | "turns">;
  drivers: AddDrivers;
  record: RecordActivity;
  // What Add devices shows may have changed.
  onChange: () => void;
}) {
  const { devices, drivers, record } = options;
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
          refusals: lister.refusals,
        };
      });
      lists.set(driver, { run: lister.run, found });
      options.onChange();
    },

    /** For someone the gate has let through: adds a found device with their answers. */
    async add(
      actor: Actor,
      who: ActivityAuthor,
      input: unknown,
    ): Promise<AddResult> {
      const parsed = addRequest.safeParse(input);
      if (!parsed.success) {
        throw new ActionCallError("invalid_request");
      }
      const { driver, key } = parsed.data;
      return devices.turns.take({ driver, key }, async (hold) => {
        // As it is once its turn comes: an add before may have added it.
        const had = devices.idFor(driver, key);
        const device = had ? devices.get(had) : null;
        if (device) return { added: device };
        const found = listed(driver, key);
        const answers = answersTo(found.asks, parsed.data.answers ?? {});
        if (!answers) {
          log(found, "refused", who, "invalid_request");
          throw new ActionCallError("invalid_request");
        }
        let result: unknown;
        try {
          result = await drivers.add(driver, { key, answers }, actor, hold);
        } catch (error) {
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
          throw failure;
        }
        if (result !== undefined) {
          const said = z.object({ refused: z.unknown() }).safeParse(result);
          if (
            !said.success ||
            !isDeclaredAddRefusal(found.asks, found.refusals, said.data.refused)
          ) {
            log(found, "failed", who, "app_failed");
            throw new ActionCallError("app_failed");
          }
          const refused = said.data.refused;
          log(found, "refused", who, refused.refusal);
          return {
            refused:
              "question" in refused
                ? { question: refused.question, refusal: refused.refusal }
                : { refusal: refused.refusal },
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
        return { added };
      });
    },
  };
}

export type Found = ReturnType<typeof createFound>;
