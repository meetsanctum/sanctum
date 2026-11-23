import {
  isActionError,
  type ActionDefinition,
  type Actor,
  type AppContext,
} from "@meetsanctum/app-sdk";
import type { AppStorage } from "@meetsanctum/app-sdk/storage";

import type {
  Activity,
  ActivityAuthor,
  Joining,
} from "../activity/activity.js";
import { activityTimes } from "../activity/kinds.js";
import type { Outcome } from "../activity/schema.js";
import type { AppContract, DeclaredAction } from "./contract.js";
import { ActionCallError, TimedOut, withTimeout } from "./errors.js";
import type { EmittedEvent } from "./app-work.js";
import { opensTurn, type Turn } from "../models/turns.js";

// Runs apps' actions for the app host and writes them to the activity log.
// What a call does points back to its entry, so a light a mood turned on
// names whoever ran the mood.

// An app's own call joins its last entry for the same action.
const appSteps: Joining = {
  withinMs: activityTimes.adjustmentsJoinMs,
  matches: () => true,
};

type DeviceSubject = { id: string; name: string; title: string; done: string };

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createActionRunner<
  Entry extends {
    app: { id: string };
    storage: AppStorage;
    actions: ReadonlyMap<string, ActionDefinition>;
    contract: AppContract;
  },
>(options: {
  activity: Activity;
  timeoutMs: number;
  log: (message: string) => void;
  // A context for the app's code acting as `actor`, whose events wait in
  // `held` until the call has succeeded.
  contextFor: (
    entry: Entry,
    actor: Actor,
    storage: ReturnType<AppStorage["call"]>,
    events: { held: EmittedEvent[]; withinMs: number; turn?: Turn },
  ) => AppContext;
  // Hands on the events a call held back.
  deliver: (events: readonly EmittedEvent[]) => void;
  // A turn for a person's or a shared device's call to an action that
  // declares one, in which the app may ask the home's AI model.
  turnFor: (entry: Entry, who: ActivityAuthor) => Turn;
  deviceById: (id: string) => {
    name: string | null;
    driverName: string;
    driver: string;
  } | null;
}) {
  const { activity, timeoutMs, log } = options;
  const runningDeviceEntries = new Set<string>();

  // An activity entry for a call, with who is behind it.
  function record(
    appId: string,
    actionId: string,
    who: ActivityAuthor,
    outcome: Outcome,
    reason?: string,
    subject?: string | DeviceSubject,
    isRunning = false,
  ) {
    const device = typeof subject === "object" ? subject : undefined;
    const subjectId = typeof subject === "string" ? subject : device?.id;
    let joining: Joining | undefined;
    if (device && !isRunning) {
      joining = {
        ...appSteps,
        matches: (previous) =>
          !runningDeviceEntries.has(previous.id) &&
          previous.detail?.actionTitle === device.title &&
          previous.detail?.actionDone === device.done,
      };
    } else if (!device && who.actor?.startsWith("app:") && !activity.cause()) {
      joining = appSteps;
    }
    return activity.for(appId)(
      {
        action: actionId,
        outcome,
        reason,
        subjectId,
        detail: device && {
          name: device.name,
          actionTitle: device.title,
          actionDone: device.done,
        },
        ...who,
      },
      joining,
    );
  }

  // The app's own device a call acts on, where its action says it acts on
  // one: another app's device, or none, leaves the entry about nothing.
  function deviceOf(
    appId: string,
    declared: DeclaredAction,
    input: unknown,
  ): DeviceSubject | undefined {
    if (!declared.aboutDevice) return undefined;
    const id = (input as { device?: unknown } | null)?.device;
    if (typeof id !== "string") return undefined;
    const device = options.deviceById(id);
    if (device?.driver !== appId) return undefined;
    return {
      id,
      name: device.name ?? device.driverName,
      title: declared.title,
      done: declared.aboutDevice.done,
    };
  }

  function recordRefusal(
    appId: string,
    action: DeclaredAction,
    who: ActivityAuthor,
    reason: string,
    rawInput: unknown,
  ) {
    const input = action.aboutDevice ? action.input(rawInput) : undefined;
    const device = input?.success
      ? deviceOf(appId, action, input.data)
      : undefined;
    record(appId, action.id, who, "refused", reason, device);
  }

  // Runs one action as an actor the gate has already admitted: the input is
  // checked against the manifest's schema, the action runs with a timeout,
  // and its output is checked too. Events it emits go out only once it has
  // succeeded. Refusals, and every call that may change something, whether
  // it succeeds or fails, go to the activity log.
  async function execute(
    entry: Entry,
    declared: DeclaredAction,
    actor: Actor,
    who: ActivityAuthor,
    rawInput: unknown,
    withinMs = timeoutMs,
  ): Promise<unknown> {
    const appId = entry.app.id;
    const action = entry.actions.get(declared.id);
    if (!action) {
      throw new ActionCallError("not_found");
    }
    // What the app's own schemas make of a value, on its side of the call. A
    // schema's transform or refinement is app code too, and may throw instead
    // of returning a validation result; that answers nothing.
    const parse = (schema: ActionDefinition["input"], value: unknown) => {
      try {
        return schema.safeParse(value);
      } catch (error) {
        log(`apps: ${action.id} schema failed (${message(error)})`);
        return undefined;
      }
    };

    if (!declared.input(rawInput).success) {
      throw new ActionCallError("invalid_request");
    }
    const input = parse(action.input, rawInput);
    if (!input) {
      throw new ActionCallError("app_failed");
    }
    if (!input.success) {
      throw new ActionCallError("invalid_request");
    }

    const device = deviceOf(appId, declared, input.data);
    const isWrite = declared.tier !== "read";
    let logged: string | undefined;
    let runningEntry: string | undefined;
    // A device change can join once it succeeds. If it causes activity of
    // its own first, give that activity a dedicated entry to point back to.
    const parent = device && isWrite ? activity.cause() : undefined;
    const cause = {
      get id() {
        // A child's transaction can roll back the entry it first needed.
        if (!logged || (runningEntry && !activity.get(runningEntry))) {
          if (runningEntry) runningDeviceEntries.delete(runningEntry);
          logged = activity.within(parent ?? {}, () =>
            record(appId, action.id, who, "ok", undefined, device, true),
          );
          runningEntry = logged;
          runningDeviceEntries.add(runningEntry);
        }
        return logged;
      },
    };
    const inAction = <T>(work: () => T): T => {
      if (device && isWrite) return activity.within(cause, work);
      return logged ? activity.within(logged, work) : work();
    };
    const ended = (outcome: Outcome, reason: string) => {
      const existing = logged && activity.get(logged);
      if (existing && existing.count === 1) {
        activity.update(existing.id, { outcome, reason });
      } else {
        const id = record(appId, action.id, who, outcome, reason, device);
        if (isWrite && device) logged = id;
      }
    };
    const refuse = (error: ActionCallError) => {
      ended("refused", error.code);
      return error;
    };
    // Once the action has run, a call that may have changed something is
    // logged even when it fails.
    const fail = (code: "timeout" | "app_failed") => {
      if (isWrite) ended("failed", code);
      return new ActionCallError(code);
    };

    const storage = entry.storage.call();
    const held: EmittedEvent[] = [];
    const turn = opensTurn(declared, actor)
      ? options.turnFor(entry, who)
      : undefined;
    const ctx = options.contextFor(entry, actor, storage, {
      held,
      withinMs,
      ...(turn ? { turn } : {}),
    });
    if (isWrite && !device) {
      logged = record(appId, action.id, who, "ok");
    }
    const running = () =>
      withTimeout(
        Promise.resolve().then(() => action.run(ctx, input.data)),
        withinMs,
      );
    let result: unknown;
    try {
      result = await inAction(running);
    } catch (error) {
      if (isActionError(error)) {
        throw refuse(new ActionCallError(error.code));
      }
      // From an app apart: its own schema refused the input, or its connection
      // went, which may have left the call half done.
      if (error instanceof ActionCallError) {
        if (error.code === "invalid_request") throw refuse(error);
        if (isWrite) ended("failed", error.code);
        throw error;
      }
      if (error instanceof TimedOut) {
        log(`apps: ${action.id} timed out`);
        throw fail("timeout");
      }
      log(`apps: ${action.id} failed (${message(error)})`);
      throw fail("app_failed");
    } finally {
      storage.end();
      // Its entry, if any, is the cause of the turn's.
      if (turn) inAction(() => turn.end());
      if (runningEntry) {
        runningDeviceEntries.delete(runningEntry);
        if (logged === runningEntry && !activity.get(runningEntry)) {
          logged = undefined;
        }
        runningEntry = undefined;
      }
    }

    const output = parse(action.output, result);
    const checked = output?.success ? declared.output(output.data) : undefined;
    if (!checked?.success) {
      if (output) {
        log(`apps: ${action.id} returned something its output schema refuses`);
      }
      throw fail("app_failed");
    }
    if (isWrite && device && !logged) {
      logged = record(appId, action.id, who, "ok", undefined, device);
    }
    inAction(() => options.deliver(held));
    return checked.data;
  }

  return { record, recordRefusal, execute };
}
