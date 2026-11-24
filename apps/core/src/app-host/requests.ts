import {
  aiAssistantPermission,
  assistantAppId,
  isActionError,
  turnLimits,
  type AppContext,
  type AssistantRequest,
  type RequestReply,
} from "@meetsanctum/app-sdk";
import type { AppStorage } from "@meetsanctum/app-sdk/storage";

import type { ActivityAuthor } from "../activity/activity.js";
import type { TurnOpener } from "../agents/assistants.js";
import type { Turn } from "../models/turns.js";
import { ActionCallError, TimedOut, withTimeout } from "./errors.js";
import type { InstalledApp } from "./installed.js";

// A request: someone said or typed something to Sanctum, and the core runs
// Sanctum's Assistant's handler for it, within a turn of its own for whoever
// asked. The reply goes back as soon as the handler gives it; the turn ends
// with the handler, or at its time. With no Assistant to answer, running,
// holding its permission and declaring a handler, the core answers at once.

export function createRequests(options: {
  installed: ReadonlyMap<string, InstalledApp>;
  accepts: (entry: InstalledApp) => boolean;
  arrives: (entry: InstalledApp) => Promise<boolean>;
  contextFor: (
    entry: InstalledApp,
    actor: TurnOpener,
    storage: ReturnType<AppStorage["call"]>,
    within: {
      withinMs: number;
      turn: Turn;
      reply: (reply: RequestReply) => void;
    },
  ) => AppContext;
  coreOf: (ctx: AppContext) => {
    replyRequest(reply: RequestReply): Promise<void>;
  };
  turnFor: (entry: InstalledApp, who: ActivityAuthor) => Turn;
  track: <T>(entry: InstalledApp, call: Promise<T>) => Promise<T>;
  log: (message: string) => void;
}) {
  const { installed, accepts } = options;

  function answering(entry: InstalledApp | undefined) {
    return (
      entry !== undefined &&
      entry.app.requests !== undefined &&
      entry.granted.includes(aiAssistantPermission) &&
      accepts(entry)
    );
  }

  return {
    /** Whether Sanctum's Assistant would answer a request now. */
    isOn() {
      return answering(installed.get(assistantAppId));
    },

    /**
     * Runs a request for whoever asked, and resolves with the Assistant's
     * reply, or null when it gave none; `unavailable` when it's off.
     */
    async ask(request: {
      actor: TurnOpener;
      who: ActivityAuthor;
      asked: AssistantRequest;
    }): Promise<RequestReply | null> {
      let entry = installed.get(assistantAppId);
      // One on its way back is waited for, within the turn's time.
      if (entry && !answering(entry) && entry.app.requests) {
        if (!(await options.arrives(entry))) entry = undefined;
      }
      if (
        !entry ||
        !answering(entry) ||
        installed.get(assistantAppId) !== entry
      ) {
        throw new ActionCallError("unavailable");
      }
      const handler = entry.app.requests!;
      const storage = entry.storage.call();
      const turn = options.turnFor(entry, request.who);
      let given: (reply: RequestReply | null) => void = () => {};
      const replied = new Promise<RequestReply | null>((resolve) => {
        given = resolve;
      });
      let answered = false;
      const ctx = options.contextFor(entry, request.actor, storage, {
        withinMs: turnLimits.turnMs,
        turn,
        reply(reply) {
          if (answered) throw new Error("A request is answered once");
          answered = true;
          given(reply);
        },
      });
      const core = options.coreOf(ctx);
      const running = options
        .track(
          entry,
          withTimeout(
            Promise.resolve().then(() =>
              handler(ctx, {
                ...request.asked,
                reply: (reply) => core.replyRequest(reply),
              }),
            ),
            turnLimits.turnMs,
          ),
        )
        .catch((error: unknown) => {
          if (!isActionError(error)) {
            options.log(
              `apps: ${assistantAppId} did not answer a request (${error instanceof TimedOut ? "timed out" : error instanceof Error ? error.message : String(error)})`,
            );
          }
        })
        .finally(() => {
          storage.end();
          turn.end();
          given(null);
        });
      void running;
      return replied;
    },
  };
}

export type Requests = ReturnType<typeof createRequests>;
