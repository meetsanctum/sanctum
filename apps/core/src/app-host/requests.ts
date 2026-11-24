import {
  aiAssistantPermission,
  assistantAppId,
  isActionError,
  turnLimits,
  type AssistantRequest,
  type RequestContext,
  type RequestReply,
} from "@meetsanctum/app-sdk";

import type { ActivityAuthor } from "../activity/activity.js";
import type { TurnOpener } from "../agents/assistants.js";
import { createAgentLimiter } from "../agents/limits.js";
import type { Turn } from "../models/turns.js";
import { ActionCallError, TimedOut, withTimeout } from "./errors.js";
import type { InstalledApp } from "./installed.js";

// A typed request runs the Assistant's handler within a turn for whoever
// asked. The reply goes back as soon as the handler gives it. The turn and
// its admission slot stay open until the handler finishes or its time is up.

export function createRequests(options: {
  installed: ReadonlyMap<string, InstalledApp>;
  accepts: (entry: InstalledApp) => boolean;
  arrives: (entry: InstalledApp, signal: AbortSignal) => Promise<boolean>;
  contextFor: (
    entry: InstalledApp,
    actor: TurnOpener,
    scope: { readonly ended: boolean },
    within: {
      withinMs: number;
      turn: Turn;
      reply: (reply: RequestReply) => void;
    },
  ) => RequestContext;
  coreOf: (ctx: RequestContext) => {
    replyRequest(reply: RequestReply): Promise<void>;
  };
  turnFor: (entry: InstalledApp, who: ActivityAuthor) => Turn;
  track: <T>(entry: InstalledApp, call: Promise<T>) => Promise<T>;
  log: (message: string) => void;
}) {
  const { installed, accepts } = options;
  const stopping = new AbortController();
  const { signal } = stopping;
  // Leave room for other clients when one client has a request under way.
  const limiter = createAgentLimiter({
    agentPerMinute: 12,
    homePerMinute: 60,
    agentAtOnce: 1,
    homeAtOnce: 4,
  });

  function canAnswer(entry: InstalledApp) {
    return (
      entry.app.requests !== undefined &&
      entry.granted.includes(aiAssistantPermission)
    );
  }

  function dispatch(
    entry: InstalledApp,
    request: {
      actor: TurnOpener;
      who: ActivityAuthor;
      asked: AssistantRequest;
    },
  ) {
    const app = entry.app;
    const turn = options.turnFor(entry, request.who);
    let resolveReply!: (answer: RequestReply | null) => void;
    let rejectReply!: (error: ActionCallError) => void;
    const replied = new Promise<RequestReply | null>((resolve, reject) => {
      resolveReply = resolve;
      rejectReply = reject;
    });
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
    });
    let ended = false;
    let answered = false;
    const ctx = options.contextFor(
      entry,
      request.actor,
      {
        get ended() {
          return ended;
        },
      },
      {
        withinMs: turnLimits.turnMs,
        turn,
        reply(answer) {
          if (answered) throw new Error("A request is answered once");
          answered = true;
          resolveReply(answer);
        },
      },
    );
    const core = options.coreOf(ctx);
    signal.addEventListener("abort", cancel, { once: true });
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return app.requests!(ctx, {
        ...request.asked,
        reply: (answer) => core.replyRequest(answer),
      });
    });
    const running = options.track(
      entry,
      withTimeout(Promise.race([work, cancelled]), turnLimits.turnMs),
    );

    function finish(failure?: { error: unknown }) {
      const error = failure?.error;
      signal.removeEventListener("abort", cancel);
      ended = true;
      try {
        turn.end();
      } catch {
        options.log(`apps: ${assistantAppId} could not close a request's turn`);
      } finally {
        if (error instanceof ActionCallError && error.code === "unavailable") {
          rejectReply(error);
        } else {
          resolveReply(null);
          if (failure && !isActionError(error)) {
            const reason = error instanceof TimedOut ? "timed out" : "failed";
            options.log(`apps: ${assistantAppId} request ${reason}`);
          }
        }
      }
    }

    return {
      reply: replied,
      finished: running.then(
        () => finish(),
        (error: unknown) => finish({ error }),
      ),
    };
  }

  return {
    /** Stops new requests and releases callers before the HTTP server closes. */
    close() {
      stopping.abort(new ActionCallError("unavailable"));
    },

    /**
     * Runs a request for whoever asked, and resolves with the Assistant's
     * reply, or null when it gave none; `unavailable` when it's off.
     */
    async ask(request: {
      actor: TurnOpener;
      who: ActivityAuthor & { clientId: string };
      asked: AssistantRequest;
      checkClient: () => void;
    }): Promise<RequestReply | null> {
      signal.throwIfAborted();
      const entry = installed.get(assistantAppId);
      if (!entry || !canAnswer(entry)) {
        throw new ActionCallError("unavailable");
      }
      const client = request.who.clientId;
      if (limiter.takeRequest(client)) throw new ActionCallError("limited");
      const slot = limiter.begin(client);
      if (!("done" in slot)) throw new ActionCallError("limited");

      try {
        if (!accepts(entry)) {
          if (!(await options.arrives(entry, signal))) {
            throw new ActionCallError("unavailable");
          }
          signal.throwIfAborted();
          if (
            installed.get(assistantAppId) !== entry ||
            !canAnswer(entry) ||
            !accepts(entry)
          ) {
            throw new ActionCallError("unavailable");
          }
        }
        request.checkClient();
        const { reply, finished } = dispatch(entry, request);
        void finished.then(slot.done, slot.done);
        return reply;
      } catch (error) {
        slot.done();
        throw error;
      }
    },
  };
}
