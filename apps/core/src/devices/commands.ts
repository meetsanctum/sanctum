import { ActionCallError } from "../app-host/errors.js";
import type { StoredSetBy } from "./schema.js";
import {
  reconcile,
  settle,
  type CapabilitySync,
  type Prepared,
  type Settled,
} from "./sync.js";

type State = Record<string, unknown>;

// What a command sends once more when its device has not confirmed it in
// time: what went to the driver, and how to send it again, once. A
// command with nothing to send that waits for an "off" on its way shares
// that off's, so the off goes again once in all, when the off's time is
// up, and fails with it when it cannot go.
type Retry = {
  send: State;
  deliver: (send: State, onResend: () => void) => Promise<void>;
  hasResent: boolean;
  // A newer move has the light: it is not sent again.
  isCancelled?: boolean;
  // Commands sharing this send also share its delivery and confirmation wait.
  deadline?: number;
  sentAt?: number;
  failure?: string;
  // Called as it goes again, for the entry of the command that sent it.
  resent?: () => void;
};

type Attribution = {
  setBy: StoredSetBy | null;
  order: number;
};

type Command = {
  state: Settled;
  // Who set the capability, including a later command that left its target alone.
  attribution: Attribution;
  previous?: Command;
  hasFailed?: boolean;
  deadline?: number;
  // When it last went to the driver, by the core's clock.
  sentAt?: number;
  // What it sends again: its own, or the off on its way it waits for.
  retry?: Retry;
  // Called when its time to be confirmed runs out unconfirmed.
  unanswered?: (reason: string, hasResent: boolean) => void;
};

/** What Devices hears of a command it delivered. */
export type Delivered = {
  unanswered?: (reason: string, hasResent: boolean) => void;
  resent?: () => void;
};

// A delivery can finish after a newer command, a report or a new
// registration. Only the current command may change the stored target.
// Keep its predecessor until delivery succeeds, so failures in either
// order restore the last target that has not failed, and who set it.
//
// A command the device has not confirmed by its deadline goes once more,
// and has as long again: the device's last report decides first, and only
// a command that would end in conflict goes again. Only the current one
// does, the last target that has not failed, so a newer command or move
// keeps an older one from going again. Nothing goes again after a restart.
export function createCommandTracking(options: {
  confirmMs: number;
  read: (device: string, capability: string) => CapabilitySync | undefined;
  write: (
    device: string,
    capability: string,
    state: Settled,
    setBy?: StoredSetBy | null,
  ) => Settled;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const tracked = new Map<string, { current: Command }>();
  const timers = new Map<string, NodeJS.Timeout>();
  let lastOrder = 0;
  // Set once the core starts stopping: nothing goes again from then on.
  let isClosing = false;
  const keyOf = (device: string, capability: string) =>
    `${device}/${capability}`;

  function track(key: string, before: Settled & { setBy: StoredSetBy | null }) {
    const existing = tracked.get(key);
    if (existing) return existing;
    const entry: { current: Command } = {
      current: {
        state: {
          desired: before.desired,
          sync: before.sync,
          awaiting: before.awaiting,
        },
        attribution: { setBy: before.setBy, order: 0 },
      },
    };
    tracked.set(key, entry);
    return entry;
  }

  function attribute(command: Command | undefined, attribution: Attribution) {
    while (command) {
      if (command.attribution.order < attribution.order) {
        command.attribution = attribution;
      }
      command = command.previous;
    }
  }

  function stop(key: string) {
    clearTimeout(timers.get(key));
    timers.delete(key);
  }

  function wait(device: string, capability: string, command: Command) {
    const key = keyOf(device, capability);
    stop(key);
    const deadline = command.retry ? command.retry.deadline : command.deadline;
    if (command.state.sync !== "pending" || deadline === undefined) {
      return;
    }
    const expire = () => {
      timers.delete(key);
      if (tracked.get(key)?.current !== command) {
        return;
      }
      const row = options.read(device, capability);
      if (!row) {
        return;
      }
      const settled = settle({ ...row, ...command.state });
      const { retry } = command;
      if (
        settled.sync === "conflict" &&
        retry &&
        !retry.hasResent &&
        !retry.isCancelled &&
        !retry.failure &&
        !isClosing
      ) {
        void resend(device, capability, command, retry);
        return;
      }
      command.state = options.write(device, capability, settled);
      if (command.state.sync === "conflict") {
        command.unanswered?.(
          retry?.failure ?? "no_answer",
          retry?.hasResent === true,
        );
      }
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      expire();
    } else {
      const timer = setTimeout(expire, remaining);
      timer.unref();
      timers.set(key, timer);
    }
  }

  // Sends the current command once more, still pending: by now no report
  // is from before an earlier command, so it awaits none of their on and
  // off, and its deadline starts again once it has gone. One that cannot
  // go fails then, with why; it never restores an earlier target, and one
  // that finishes after a newer command changes nothing of it.
  async function resend(
    device: string,
    capability: string,
    command: Command,
    retry: Retry,
  ) {
    const key = keyOf(device, capability);
    retry.deadline = undefined;
    command.state = options.write(device, capability, {
      ...command.state,
      awaiting: undefined,
    });
    if (command.state.sync !== "pending") {
      // Its capability no longer supports what it asks.
      command.unanswered?.("no_answer", false);
      return;
    }
    try {
      await retry.deliver(retry.send, () => {
        retry.hasResent = true;
        try {
          retry.resent?.();
        } catch {
          // Its entry not saying so must not keep it from going, or waiting.
        }
      });
    } catch (error) {
      retry.failure =
        error instanceof ActionCallError ? error.code : "app_failed";
    }
    retry.sentAt = now().getTime();
    retry.deadline = retry.failure
      ? Date.now()
      : Date.now() + options.confirmMs;
    const latest = tracked.get(key)?.current;
    if (latest?.retry === retry) {
      wait(device, capability, latest);
    }
  }

  return {
    // A delivered move changes who set the light without changing its
    // target. Restoring any earlier target must keep that newer attribution.
    moved(device: string, capability: string, setBy: StoredSetBy) {
      attribute(tracked.get(keyOf(device, capability))?.current, {
        setBy,
        order: ++lastOrder,
      });
    },

    // Leave the target and its timer alone. A late delivery can still set
    // the attribution of a target a newer command would restore on failure.
    beginWithoutTarget(
      device: string,
      capability: string,
      before: Settled & { setBy: StoredSetBy | null },
      setBy: StoredSetBy,
    ) {
      const key = keyOf(device, capability);
      const entry = track(key, before);
      const attribution = { setBy, order: ++lastOrder };
      return () => {
        if (tracked.get(key) !== entry) return false;
        attribute(entry.current, attribution);
        return entry.current.attribution === attribution;
      };
    },

    // A move on its way has the light: no command it overtakes, nor one a
    // failure could restore, goes again. Their targets still settle at
    // their deadlines.
    moving(device: string, capability: string) {
      let command = tracked.get(keyOf(device, capability))?.current;
      while (command) {
        if (command.retry) command.retry.isCancelled = true;
        command = command.previous;
      }
    },

    begin(
      device: string,
      capability: string,
      before: Settled & { setBy: StoredSetBy | null },
      state: Prepared,
      setBy: StoredSetBy,
      deliver: Retry["deliver"],
    ) {
      const key = keyOf(device, capability);
      const entry = track(key, before);
      const predecessor = entry.current;
      const own: Retry | undefined = state.send
        ? { send: state.send, deliver, hasResent: false }
        : undefined;
      const command: Command = {
        state,
        attribution: { setBy, order: ++lastOrder },
        previous: predecessor,
        retry:
          own ?? (state.sync === "pending" ? predecessor.retry : undefined),
      };
      stop(key);
      entry.current = command;
      command.state = options.write(device, capability, state, setBy);
      return {
        sent(delivered: Delivered = {}) {
          command.unanswered = delivered.unanswered;
          if (own) own.resent = delivered.resent;
          command.previous = undefined;
          command.sentAt = now().getTime();
          command.deadline = Date.now() + options.confirmMs;
          if (own) {
            own.sentAt = command.sentAt;
            own.deadline = command.deadline;
          }
          const latest = tracked.get(key)?.current;
          if (latest && (latest === command || (own && latest.retry === own))) {
            wait(device, capability, latest);
          }
        },
        failed(reason: string) {
          // A device report is stronger evidence than a delivery error.
          // An off with a look is confirmed too, with that look held.
          if (
            command.state.sync === "synced" ||
            command.state.sync === "held"
          ) {
            return;
          }
          command.hasFailed = true;
          if (own) {
            own.failure = reason;
            own.deadline = Date.now();
          }
          const latest = tracked.get(key)?.current;
          if (latest !== command) {
            // A colour may have replaced this off without sending anything
            // itself. It cannot wait for an off the driver could not deliver.
            if (own && latest?.retry === own) {
              wait(device, capability, latest);
            }
            return;
          }
          let previous = command.previous!;
          while (previous.hasFailed) {
            previous = previous.previous!;
          }
          entry.current = previous;
          previous.state = options.write(
            device,
            capability,
            previous.state,
            previous.attribution.setBy,
          );
          wait(device, capability, previous);
        },
      };
    },

    reported(
      device: string,
      capability: string,
      row: CapabilitySync,
      observed: Record<string, unknown>,
    ) {
      const key = keyOf(device, capability);
      let command = tracked.get(key)?.current;
      // A report can also confirm a target we would restore on failure.
      while (command) {
        command.state = reconcile({ ...row, ...command.state }, observed);
        command = command.previous;
      }
      if (tracked.get(key)?.current.state.sync !== "pending") {
        stop(key);
      }
    },

    /** When the capability's current command last went to its driver, by the core's clock. */
    sentAt(device: string, capability: string) {
      const command = tracked.get(keyOf(device, capability))?.current;
      return command?.retry?.sentAt ?? command?.sentAt;
    },

    forget(device: string, capability: string) {
      const key = keyOf(device, capability);
      stop(key);
      tracked.delete(key);
    },

    // The core is stopping: what has yet to be confirmed fails at its
    // deadline, without going again.
    closing() {
      isClosing = true;
    },

    close() {
      isClosing = true;
      for (const key of timers.keys()) {
        stop(key);
      }
      tracked.clear();
    },
  };
}
