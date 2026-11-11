import {
  isActionError,
  type ActionDefinition,
  type Actor,
  type AppContext,
} from "@meetsanctum/app-sdk";
import type { AppStorage } from "@meetsanctum/app-sdk/storage";

import type { Activity, Joining } from "../activity/activity.js";
import { activityTimes } from "../activity/kinds.js";
import type { Outcome } from "../activity/schema.js";
import type { AppContract, DeclaredAction } from "./contract.js";
import { ActionCallError, TimedOut, withTimeout } from "./errors.js";
import type { AppEvent } from "./host.js";

// Runs apps' actions for the app host and writes them to the activity log. A
// call that may change something has its entry as it starts, and what the
// action does has it as its cause, so a light a mood turned on names whoever
// ran the mood; how the call ended changes the entry after.

// Who is behind a call, for the activity log: the person and client behind
// a request, or the workflow or app acting on its own.
export type Who = { personId?: string; clientId?: string; actor?: string };

// An app's own call joins its last entry for the same action.
const appSteps: Joining = {
  withinMs: activityTimes.adjustmentsJoinMs,
  matches: () => true,
};

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
    events: { held: AppEvent[]; withinMs: number },
  ) => AppContext;
  // Hands on the events a call held back.
  deliver: (events: readonly AppEvent[]) => void;
}) {
  const { activity, timeoutMs, log } = options;

  // An activity entry for a call, with who is behind it.
  function record(
    appId: string,
    actionId: string,
    who: Who,
    outcome: Outcome,
    reason?: string,
    subjectId?: string,
  ) {
    return activity.for(appId)(
      { action: actionId, outcome, reason, subjectId, ...who },
      // An app acting on its own, as on a job, joins its last entry for
      // the same action, so natural light's steps are one entry.
      who.actor && !activity.cause() ? appSteps : undefined,
    );
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
    who: Who,
    rawInput: unknown,
    withinMs = timeoutMs,
  ): Promise<unknown> {
    const appId = entry.app.id;
    const action = entry.actions.get(declared.id);
    if (!action) {
      throw new ActionCallError("not_found");
    }
    let logged: string | undefined;
    const ended = (outcome: Outcome, reason: string) => {
      const joined = logged && activity.get(logged);
      if (joined && joined.count === 1) {
        activity.update(logged!, { outcome, reason });
      } else {
        record(appId, action.id, who, outcome, reason);
      }
    };
    const refuse = (error: ActionCallError) => {
      ended("refused", error.code);
      return error;
    };
    // Once the action has run, a call that may have changed something is
    // logged even when it fails.
    const fail = (code: "timeout" | "app_failed") => {
      if (declared.tier !== "read") {
        ended("failed", code);
      }
      return new ActionCallError(code);
    };
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

    const storage = entry.storage.call();
    const held: AppEvent[] = [];
    const ctx = options.contextFor(entry, actor, storage, { held, withinMs });
    if (declared.tier !== "read") {
      logged = record(appId, action.id, who, "ok");
    }
    const running = () =>
      withTimeout(
        Promise.resolve().then(() => action.run(ctx, input.data)),
        withinMs,
      );
    let result: unknown;
    try {
      result = await (logged ? activity.within(logged, running) : running());
    } catch (error) {
      if (isActionError(error)) {
        throw refuse(new ActionCallError(error.code));
      }
      // From an app apart: its own schema refused the input, or its connection
      // went, which may have left the call half done.
      if (error instanceof ActionCallError) {
        if (error.code === "invalid_request") throw refuse(error);
        if (declared.tier !== "read") ended("failed", error.code);
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
    }

    const output = parse(action.output, result);
    const checked = output?.success ? declared.output(output.data) : undefined;
    if (!checked?.success) {
      if (output) {
        log(`apps: ${action.id} returned something its output schema refuses`);
      }
      throw fail("app_failed");
    }
    const deliver = () => options.deliver(held);
    if (logged) activity.within(logged, deliver);
    else deliver();
    return checked.data;
  }

  return { record, execute };
}
