import type { Actor } from "@meetsanctum/app-sdk";

import type { Principal } from "../auth/clients.js";
import type { createActionRunner, Who } from "./actions.js";
import { appStateOf } from "./app-info.js";
import type { DeclaredAction } from "./contract.js";
import { ActionCallError } from "./errors.js";
import type { Gate } from "./gate.js";
import type { InstalledApp } from "./installed.js";
import type { Supervisor } from "./supervisor.js";

type ActionRunner = ReturnType<typeof createActionRunner<InstalledApp>>;

// Calls to installed apps' actions: a client's request, which the gate admits
// as an actor, and a workflow's or the app's own, which the gate permits. Each
// runs while the app takes calls, and a refusal goes to the activity log.
export function createActionCalls(options: {
  installed: ReadonlyMap<string, InstalledApp>;
  gate: Gate;
  supervisor: Pick<Supervisor, "arrives">;
  accepts: (entry: InstalledApp) => boolean;
  record: ActionRunner["record"];
  execute: ActionRunner["execute"];
  // Counts a call under way until it settles.
  track: <T>(entry: InstalledApp, call: Promise<T>) => Promise<T>;
  timeoutMs: number;
}) {
  const { installed, gate, supervisor, accepts, record, execute, timeoutMs } =
    options;

  function find(appId: string, actionId: string) {
    const entry = installed.get(appId);
    const action = entry?.contract.actions.get(actionId);
    if (!entry || !action) {
      throw new ActionCallError("not_found");
    }
    return { entry, action };
  }

  // Runs an action the gate has admitted, while the app takes calls. A
  // call refused because it does not may have changed something, so it is
  // logged unless it only reads: pages keep reading a paused app.
  async function run(
    entry: InstalledApp,
    action: DeclaredAction,
    actor: Actor,
    who: Who,
    input: unknown,
  ) {
    const deadline = Date.now() + timeoutMs;
    // One on its way back is waited for, within a call's time, rather than fail.
    if (!accepts(entry) && appStateOf(entry) !== "paused") {
      await supervisor.arrives(entry, timeoutMs);
    }
    const withinMs = deadline - Date.now();
    if (
      installed.get(entry.app.id) !== entry ||
      !accepts(entry) ||
      withinMs <= 0
    ) {
      if (action.tier !== "read") {
        record(entry.app.id, action.id, who, "refused", "unavailable");
      }
      throw new ActionCallError("unavailable");
    }
    return options.track(
      entry,
      execute(entry, action, actor, who, input, withinMs),
    );
  }

  return {
    // Runs one action for the principal behind a request: the gate admits
    // the caller as an actor first.
    async call(request: {
      principal: Principal;
      appId: string;
      actionId: string;
      input: unknown;
    }): Promise<unknown> {
      const { principal } = request;
      const { entry, action } = find(request.appId, request.actionId);
      const who =
        principal.scope === "agent"
          ? { actor: `assistant-run:${principal.client.id}` }
          : { personId: principal.person?.id, clientId: principal.client.id };
      let actor: Actor;
      try {
        actor = gate.admit(principal, action);
      } catch (error) {
        if (error instanceof ActionCallError) {
          record(entry.app.id, action.id, who, "refused", error.code);
        }
        throw error;
      }
      return run(entry, action, actor, who, request.input);
    },

    // Runs one action for a workflow or for the app itself, as a job does:
    // the gate permits the actor, then the call goes as any other.
    async invoke(request: {
      actor: Actor;
      appId: string;
      actionId: string;
      input: unknown;
    }): Promise<unknown> {
      const { actor } = request;
      const { entry, action } = find(request.appId, request.actionId);
      const who = { actor: `${actor.kind}:${actor.id}` };
      try {
        gate.permit(actor, action);
      } catch (error) {
        if (error instanceof ActionCallError) {
          record(entry.app.id, action.id, who, "refused", error.code);
        }
        throw error;
      }
      return run(entry, action, actor, who, request.input);
    },
  };
}
