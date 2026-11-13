import {
  deviceJoining,
  type Actor,
  type JoinedDevice,
  type PairingInfo,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import type { RecordActivity } from "../activity/activity.js";
import type { Outcome } from "../activity/schema.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Rule } from "../app-host/gate.js";

// Adding devices: pairing is the core's flow, whatever the radio. Someone
// lets new devices join for a while; the core asks every running driver app
// that can pair to open its network, and the drivers say how each device
// that joins is getting on until it is ready. Each driver's network closes
// by itself when its time is up, so nothing of this outlives the core.

// Every client adds devices, shared ones too: anything nearby may join
// meanwhile.
export const pairingRules = {
  read: { tier: "read" },
  change: { tier: "write" },
} as const satisfies Record<string, Rule>;

export const pairingRequest = z.object({
  // Zigbee lets devices join for at most 254 seconds at a time.
  seconds: z.number().int().min(1).max(254).default(240),
});

/** The driver apps that can pair, through the app host. */
export type PairingDrivers = {
  list(): string[];
  open(
    driver: string,
    seconds: number,
    actor: Actor,
  ): Promise<{ until: string | null }>;
  close(driver: string, actor: Actor): Promise<void>;
};

// The person and client behind a call, for the activity log.
type Who = { personId?: string; clientId?: string };

// A device that joined stays on the list for an hour, so whoever is adding
// devices can still name it; the list keeps the latest few dozen.
const keptMs = 60 * 60_000;
const keptDevices = 64;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createPairing(options: {
  drivers: PairingDrivers;
  // The core's id for a driver's device, if it has it.
  deviceId: (driver: string, key: string) => string | null;
  record: RecordActivity;
  // Called after every change, so live clients can follow.
  onChange?: (pairing: PairingInfo) => void;
  log: (message: string) => void;
  now?: () => Date;
}) {
  const { drivers, record, log } = options;
  const now = options.now ?? (() => new Date());
  const deadlines = new Map<string, number>();
  const opening = new Set<string>();
  let pending: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let joined: JoinedDevice[] = [];

  const isOpen = (driver: string) =>
    opening.has(driver) || (deadlines.get(driver) ?? 0) > now().getTime();

  // Open and close calls must reach the radios in the order requested.
  function sequence<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(work);
    pending = result.catch(() => undefined);
    return result;
  }

  function prune() {
    joined = joined
      .filter((each) => now().getTime() - Date.parse(each.joinedAt) < keptMs)
      .slice(-keptDevices);
  }

  function info(): PairingInfo {
    prune();
    const until = Math.max(0, ...deadlines.values());
    return {
      until: until > now().getTime() ? new Date(until).toISOString() : null,
      joined: joined.map((each) => ({ ...each })),
    };
  }

  function changed() {
    options.onChange?.(info());
  }

  function end() {
    clearTimeout(timer);
    timer = undefined;
    deadlines.clear();
  }

  function schedule() {
    clearTimeout(timer);
    const until = Math.max(0, ...deadlines.values());
    if (!until) return;
    timer = setTimeout(
      () => {
        end();
        changed();
      },
      Math.max(0, until - now().getTime()),
    );
  }

  function note(action: string, who: Who, outcome: Outcome, reason?: string) {
    record({
      action,
      outcome,
      reason,
      personId: who.personId,
      clientId: who.clientId,
    });
  }

  return {
    info,

    // Lets new devices join every driver's network that can pair, for
    // someone the gate has let through. Opening again while open starts the
    // time again. It answers until when, and since when: what joined from
    // then on is what this person is adding.
    open(
      actor: Actor,
      who: Who,
      input: unknown,
    ): Promise<PairingInfo & { since: string }> {
      return sequence(async () => {
        const parsed = pairingRequest.safeParse(input ?? {});
        if (!parsed.success) {
          throw new ActionCallError("invalid_request");
        }
        const since = now();
        const ids = drivers.list();
        const answers = await Promise.allSettled(
          ids.map(async (driver) => {
            opening.add(driver);
            try {
              const answer = await drivers.open(
                driver,
                parsed.data.seconds,
                actor,
              );
              const end =
                answer.until === null ? null : Date.parse(answer.until);
              if (
                end !== null &&
                (!Number.isFinite(end) || end <= now().getTime())
              ) {
                throw new ActionCallError("app_failed");
              }
              if (end !== null) deadlines.set(driver, end);
              else deadlines.delete(driver);
              schedule();
              return end;
            } finally {
              opening.delete(driver);
            }
          }),
        );
        const ends: number[] = [];
        answers.forEach((answer, index) => {
          if (answer.status === "rejected") {
            log(
              `devices: ${ids[index]} did not open (${message(answer.reason)})`,
            );
          } else if (answer.value !== null) {
            ends.push(answer.value);
          }
        });
        if (ends.length === 0) {
          const reason = answers.find((answer) => answer.status === "rejected")
            ?.reason as unknown;
          const failure =
            reason instanceof ActionCallError
              ? reason
              : new ActionCallError(ids.length ? "app_failed" : "unavailable");
          note(
            "pairing.open",
            who,
            failure.status >= 500 ? "failed" : "refused",
            failure.code,
          );
          throw failure;
        }
        schedule();
        note("pairing.open", who, "ok");
        changed();
        return { ...info(), since: since.toISOString() };
      });
    },

    // Stops letting new devices join. What joined stays on the list.
    close(actor: Actor, who: Who): Promise<PairingInfo> {
      return sequence(async () => {
        const ids = [...new Set([...drivers.list(), ...deadlines.keys()])];
        const answers = await Promise.allSettled(
          ids.map(async (driver) => {
            await drivers.close(driver, actor);
            deadlines.delete(driver);
          }),
        );
        schedule();
        changed();
        answers.forEach((answer, index) => {
          if (answer.status === "rejected") {
            log(
              `devices: ${ids[index]} did not close (${message(answer.reason)})`,
            );
          }
        });
        const failed = answers.find((answer) => answer.status === "rejected");
        if (failed) {
          const failure =
            failed.reason instanceof ActionCallError
              ? failed.reason
              : new ActionCallError("app_failed");
          note(
            "pairing.close",
            who,
            failure.status >= 500 ? "failed" : "refused",
            failure.code,
          );
          throw failure;
        }
        note("pairing.close", who, "ok");
        return info();
      });
    },

    // A driver says how a device joining its network is getting on. A
    // device that joins while nobody is adding devices is no news; one that
    // joined meanwhile is followed until it is ready, however long that
    // takes. One the core has already is named from the start: it joins
    // again as itself.
    joining(driver: string, input: unknown) {
      const parsed = deviceJoining.safeParse(input);
      if (!parsed.success) {
        throw new Error(
          `${driver} said something about a joining device the core cannot take: ${z.prettifyError(parsed.error)}`,
        );
      }
      const { key, stage, description } = parsed.data;
      const at = now();
      prune();
      const deviceId = options.deviceId(driver, key);
      const entry = joined.find(
        (each) => each.driver === driver && each.key === key,
      );
      const startsAgain =
        stage === "joined" ||
        (stage === "interviewing" &&
          entry &&
          !["joined", "interviewing"].includes(entry.stage));
      if (entry && !startsAgain) {
        entry.stage = stage;
        entry.description = description ?? entry.description;
        // The device as the core has it now, or none once it is removed.
        entry.deviceId = deviceId;
      } else if (isOpen(driver)) {
        joined = joined.filter((each) => each !== entry);
        joined.push({
          driver,
          key,
          stage,
          description,
          deviceId,
          known: deviceId !== null && stage !== "ready",
          joinedAt: at.toISOString(),
        });
        prune();
      } else {
        return;
      }
      changed();
    },

    // The core removed a device: what joined no longer names it, nor joined
    // again as a device the home has.
    removed(deviceId: string) {
      const naming = joined.filter((each) => each.deviceId === deviceId);
      for (const entry of naming) {
        entry.deviceId = null;
        entry.known = false;
      }
      if (naming.length > 0) changed();
    },

    // Forgets the timer, as when the core stops.
    stop() {
      end();
    },
  };
}

export type Pairing = ReturnType<typeof createPairing>;
