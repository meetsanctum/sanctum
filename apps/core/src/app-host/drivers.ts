import {
  isActionError,
  type Actor,
  type AppContext,
  type AppDefinition,
  type DriverCommand,
  type DriverDevice,
  type DriverMove,
  type DriverRemoval,
  type DriverRepair,
} from "@meetsanctum/app-sdk";
import type { AppStorage } from "@meetsanctum/app-sdk/storage";

import { ActionCallError, TimedOut, withTimeout } from "./errors.js";

// What Devices asks of driver apps, the Drivers contract: their devices'
// commands, moving a light while a remote's button is held, letting new
// devices join, removing one, firmware and asking a device how it is. Only a
// driver that takes calls gets them: one that is paused or stopped is
// unavailable for them.

type Driving = { app: AppDefinition; storage: AppStorage };

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createDriverCalls<Entry extends Driving>(options: {
  installed: ReadonlyMap<string, Entry>;
  // Whether the app takes calls now.
  accepts: (entry: Entry) => boolean;
  // Waits for one that's on its way back, answering whether it came in time.
  arrives: (entry: Entry) => Promise<boolean>;
  // A context for app code, acting as `actor`.
  contextFor: (
    entry: Entry,
    actor: Actor,
    storage: ReturnType<AppStorage["call"]>,
    options: { withinMs: number },
  ) => AppContext;
  // Counts a call under way until it settles, so a stop lets it finish.
  track: <T>(entry: Entry, call: Promise<T>) => Promise<T>;
  timeoutMs: number;
  log: (message: string) => void;
}) {
  const { installed, accepts, timeoutMs, log } = options;

  function driving(driverId: string) {
    const entry = installed.get(driverId);
    return entry && accepts(entry) ? entry : undefined;
  }

  // Hands a driver app one of the contract's calls, as `actor`, with a
  // timeout. A refusal reaches the caller with its code; anything else the
  // driver throws is its failure, which is logged, by its words unless the
  // call carries answers they could repeat.
  async function toDriver<T>(
    driverId: string,
    actor: Actor,
    what: string,
    call: (
      driver: NonNullable<AppDefinition["driver"]>,
      ctx: AppContext,
    ) => Promise<T>,
    { quiet = false }: { quiet?: boolean } = {},
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let entry = driving(driverId);
    if (!entry) {
      const waiting = installed.get(driverId);
      if (waiting && (await options.arrives(waiting))) entry = waiting;
    }
    const driver = entry?.app.driver;
    const withinMs = deadline - Date.now();
    if (
      !entry ||
      !driver ||
      installed.get(driverId) !== entry ||
      !accepts(entry) ||
      withinMs <= 0
    ) {
      throw new ActionCallError("unavailable");
    }
    const storage = entry.storage.call();
    const ctx = options.contextFor(entry, actor, storage, { withinMs });
    try {
      return await options.track(
        entry,
        withTimeout(
          Promise.resolve().then(() => call(driver, ctx)),
          withinMs,
        ),
      );
    } catch (error) {
      if (error instanceof ActionCallError) {
        throw error;
      }
      if (isActionError(error)) {
        throw new ActionCallError(error.code);
      }
      log(
        `apps: ${driverId} did not ${what} (${error instanceof TimedOut ? "timed out" : quiet ? "failed" : message(error)})`,
      );
      throw new ActionCallError(
        error instanceof TimedOut ? "timeout" : "app_failed",
      );
    } finally {
      storage.end();
    }
  }

  function pairingOf(driver: NonNullable<AppDefinition["driver"]>) {
    if (!driver.pairing) {
      throw new ActionCallError("unavailable");
    }
    return driver.pairing;
  }

  return {
    // Hands a command to the driver app that brings the device, as the
    // actor behind it. It resolves once the driver has sent it on; the
    // device's report confirms it.
    deliver(driverId: string, command: DriverCommand, actor: Actor) {
      return toDriver(driverId, actor, "take a command", (driver, ctx) =>
        driver.command(ctx, command),
      );
    },

    // Has a driver move one of its lights, or stop it, as while a remote's
    // button is held (holds.ts).
    move(driverId: string, move: DriverMove, actor: Actor) {
      return toDriver(driverId, actor, "move a light", (driver, ctx) => {
        if (!driver.move) {
          throw new ActionCallError("unavailable");
        }
        return driver.move(ctx, move);
      });
    },

    // Whether a driver app takes calls and can move its lights.
    canMove(driverId: string) {
      return Boolean(driving(driverId)?.app.driver?.move);
    },

    // The driver apps that take calls and can let new devices join.
    pairingDrivers() {
      return [...installed.values()].flatMap((entry) =>
        accepts(entry) && entry.app.driver?.pairing ? [entry.app.id] : [],
      );
    },

    openPairing(driverId: string, seconds: number, actor: Actor) {
      return toDriver(driverId, actor, "let devices join", (driver, ctx) =>
        pairingOf(driver).open(ctx, { seconds }),
      );
    },

    closePairing(driverId: string, actor: Actor) {
      return toDriver(
        driverId,
        actor,
        "stop letting devices join",
        (driver, ctx) => pairingOf(driver).close(ctx),
      );
    },

    // Has the driver take one of its devices off its network. A driver
    // that cannot is unavailable for it, as one that is not running is.
    removeDevice(driverId: string, removal: DriverRemoval, actor: Actor) {
      return toDriver(driverId, actor, "remove a device", (driver, ctx) => {
        if (!driver.remove) {
          throw new ActionCallError("unavailable");
        }
        return driver.remove(ctx, removal);
      });
    },

    // Hands a driver someone's firmware check, update or stop for one of
    // its devices. A driver that cannot is unavailable for it.
    firmware(
      driverId: string,
      hook: "check" | "update" | "stop",
      device: DriverDevice,
      actor: Actor,
    ) {
      return toDriver(driverId, actor, `${hook} firmware`, (driver, ctx) => {
        if (!driver.firmware) {
          throw new ActionCallError("unavailable");
        }
        return driver.firmware[hook](ctx, device);
      });
    },

    // Has a driver ask one of its devices how it is now.
    probe(driverId: string, device: DriverDevice, actor: Actor) {
      return toDriver(driverId, actor, "ask a device", (driver, ctx) => {
        if (!driver.probe) {
          throw new ActionCallError("unavailable");
        }
        return driver.probe(ctx, device);
      });
    },

    // Hands a driver someone's answers to set one of its devices right. A
    // failure is logged without its words, which could repeat an answer.
    repair(driverId: string, repair: DriverRepair, actor: Actor) {
      return toDriver(
        driverId,
        actor,
        "repair a device",
        (driver, ctx) => {
          if (!driver.repair) {
            throw new ActionCallError("unavailable");
          }
          return driver.repair(ctx, repair);
        },
        { quiet: true },
      );
    },
  };
}
