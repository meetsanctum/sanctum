import { turnLimits, type Actor } from "@meetsanctum/app-sdk";

import type { Activity, ActivityAuthor } from "../activity/activity.js";
import type { createActionRunner } from "./actions.js";
import { appStateOf } from "./app-info.js";
import type { DeclaredAction } from "./contract.js";
import { ActionCallError } from "./errors.js";
import { isAgentCaller, type Caller, type Gate } from "./gate.js";
import type { InstalledApp } from "./installed.js";
import type { Supervisor } from "./supervisor.js";
import { opensTurn } from "../models/turns.js";

type ActionRunner = ReturnType<typeof createActionRunner<InstalledApp>>;

// Calls to installed apps' actions: a client's request, which the gate admits
// as an actor, and a workflow's or the app's own, which the gate permits. An
// AI agent runs only what the app offers and the household switched on, with
// what it needs. Each runs while the app takes calls, and a refusal goes to
// the activity log.
export function createActionCalls(options: {
  installed: ReadonlyMap<string, InstalledApp>;
  gate: Gate;
  supervisor: Pick<Supervisor, "arrives">;
  accepts: (entry: InstalledApp) => boolean;
  agentWho: Activity["agentWho"];
  // Whether AI agents may run one of an app's actions now.
  agentCanUse: (appId: string, actionId: string) => boolean;
  recordRefusal: ActionRunner["recordRefusal"];
  execute: ActionRunner["execute"];
  // Counts a call under way until it settles.
  track: <T>(entry: InstalledApp, call: Promise<T>) => Promise<T>;
  timeoutMs: number;
}) {
  const {
    installed,
    gate,
    supervisor,
    accepts,
    recordRefusal,
    execute,
    timeoutMs,
  } = options;

  function find(appId: string, actionId: string) {
    const entry = installed.get(appId);
    const action = entry?.contract.actions.get(actionId);
    if (!entry || !action) {
      throw new ActionCallError("not_found");
    }
    return { entry, action };
  }

  // The gate's answer, then, for an AI agent, the household's.
  function admits(entry: InstalledApp, action: DeclaredAction, actor: Actor) {
    if (
      actor.kind === "assistant-run" &&
      !options.agentCanUse(entry.app.id, action.id)
    ) {
      throw new ActionCallError("forbidden");
    }
    return actor;
  }

  function check<T>(
    entry: InstalledApp,
    action: DeclaredAction,
    who: ActivityAuthor,
    input: unknown,
    admit: () => T,
  ): T {
    try {
      return admit();
    } catch (error) {
      if (error instanceof ActionCallError) {
        recordRefusal(entry.app.id, action, who, error.code, input);
      }
      throw error;
    }
  }

  // Runs an action the gate has admitted, while the app takes calls. A
  // call refused because it does not may have changed something, so it is
  // logged unless it only reads: pages keep reading a paused app.
  async function run(
    entry: InstalledApp,
    action: DeclaredAction,
    actor: Actor,
    who: ActivityAuthor,
    input: unknown,
  ) {
    // A turn has its own time, for the AI model's answers.
    const deadline =
      Date.now() + (opensTurn(action, actor) ? turnLimits.turnMs : timeoutMs);
    // One on its way back is waited for, within a call's time, rather than fail.
    if (!accepts(entry) && appStateOf(entry) !== "paused") {
      await supervisor.arrives(entry, timeoutMs);
      if (actor.kind === "assistant-run") {
        check(entry, action, who, input, () => {
          gate.requireActiveAgent(actor.id);
          admits(entry, action, actor);
        });
      }
    }
    const withinMs = deadline - Date.now();
    if (
      installed.get(entry.app.id) !== entry ||
      !accepts(entry) ||
      withinMs <= 0
    ) {
      if (action.tier !== "read") {
        recordRefusal(entry.app.id, action, who, "unavailable", input);
      }
      throw new ActionCallError("unavailable");
    }
    return options.track(
      entry,
      execute(entry, action, actor, who, input, withinMs),
    );
  }

  return {
    // Runs one action for who is behind a request, a client's principal or
    // an AI agent: the gate admits the caller as an actor first.
    async call(request: {
      principal: Caller;
      appId: string;
      actionId: string;
      input: unknown;
    }): Promise<unknown> {
      const caller = request.principal;
      const { entry, action } = find(request.appId, request.actionId);
      const who = isAgentCaller(caller)
        ? options.agentWho(caller.id)
        : caller.scope === "agent"
          ? options.agentWho(caller.client.id)
          : { personId: caller.person?.id, clientId: caller.client.id };
      const actor = check(entry, action, who, request.input, () =>
        admits(entry, action, gate.admit(caller, action)),
      );
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
      const who =
        actor.kind === "assistant-run"
          ? options.agentWho(actor.id)
          : { actor: `${actor.kind}:${actor.id}` };
      check(entry, action, who, request.input, () => {
        gate.permit(actor, action);
        admits(entry, action, actor);
      });
      return run(entry, action, actor, who, request.input);
    },
  };
}
