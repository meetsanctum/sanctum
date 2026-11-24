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
import type { ToolRecorder } from "./contexts.js";
import { ActionCallError, TimedOut, withTimeout } from "./errors.js";
import type { InstalledApp } from "./installed.js";
import { createRequestWindows, type Exchange } from "./request-window.js";

// A typed request runs the Assistant's handler within a turn for whoever
// asked. The reply goes back as soon as the handler gives it. The turn and
// its admission slot stay open until the handler finishes or its time is up.
//
// Each device is a conversation of its own. A newer request from it takes
// over from one still running: that one's turn ends, its signal aborts and
// its later calls are refused `turn_ended`. Its tool calls under way can't be
// pulled back, so the newer one waits up to 2 s for them to settle, and gets
// it in `earlier` with the device's other recent exchanges (request-window.ts).

/** How long a newer request waits for the tool calls of the one it ends. */
export const settleWithinMs = 2_000;

type Run = {
  device: string;
  // Aborts as a newer request takes over (`turn_ended`) or the Assistant
  // stops (`unavailable`).
  steering: AbortController;
  // Its turn's calls are refused from here on.
  ended: boolean;
  // Its handler is done, by itself or as its turn ended.
  finished: boolean;
  exchange?: Exchange;
  // Its tool calls under way.
  tools: Set<Promise<void>>;
  // Settles once its slot is free and it has left `runs`.
  done: Promise<void>;
};

function delay(ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<void>((done) => {
    timer = setTimeout(done, ms);
    timer.unref();
  });
  return { waited, clear: () => clearTimeout(timer) };
}

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
      recordTool: ToolRecorder;
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
  let closed = false;
  // Leave room for other clients when one client has a request under way.
  const limiter = createAgentLimiter({
    agentPerMinute: 12,
    homePerMinute: 60,
    agentAtOnce: 1,
    homeAtOnce: 4,
  });
  const windows = createRequestWindows();
  // The request of each device, running or about to.
  const runs = new Map<string, Run>();

  function canAnswer(entry: InstalledApp) {
    return (
      entry.app.requests !== undefined &&
      entry.granted.includes(aiAssistantPermission)
    );
  }

  // Ends a run before its handler is done: its calls are refused from now,
  // and its handler hears it through its signal.
  function endRun(run: Run, reason: ActionCallError) {
    if (run.steering.signal.aborted) return;
    run.ended = true;
    if (reason.code === "turn_ended" && run.exchange && !run.finished) {
      run.exchange.cutOff = true;
    }
    run.steering.abort(reason);
  }

  // What a newer request waits for: the older one's tool calls, for up to
  // 2 s, and its slot.
  async function settled(run: Run) {
    if (run.tools.size > 0) {
      const { waited, clear } = delay(settleWithinMs);
      await Promise.race([Promise.allSettled([...run.tools]), waited]);
      clear();
    }
    await run.done;
  }

  function dispatch(
    entry: InstalledApp,
    run: Run,
    exchange: Exchange,
    request: {
      actor: TurnOpener;
      who: ActivityAuthor;
      asked: AssistantRequest;
    },
  ) {
    const app = entry.app;
    const { signal } = run.steering;
    const turn = options.turnFor(entry, request.who);
    let resolveReply!: (answer: RequestReply | null) => void;
    let rejectReply!: (error: ActionCallError) => void;
    const replied = new Promise<RequestReply | null>((resolve, reject) => {
      resolveReply = resolve;
      rejectReply = reject;
    });
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
    let answered = false;
    const ctx = options.contextFor(
      entry,
      request.actor,
      {
        get ended() {
          return run.ended;
        },
      },
      {
        withinMs: turnLimits.turnMs,
        turn,
        reply(answer) {
          if (answered) throw new Error("A request is answered once");
          answered = true;
          exchange.reply = answer.text;
          resolveReply(answer);
        },
        recordTool(name, input) {
          const answer = windows.tool(exchange, name, input);
          let settle!: () => void;
          const underWay = new Promise<void>((done) => (settle = done));
          run.tools.add(underWay);
          return (given) => {
            answer(given);
            run.tools.delete(underWay);
            settle();
          };
        },
      },
    );
    const core = options.coreOf(ctx);
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return app.requests!(ctx, {
        ...request.asked,
        signal,
        reply: (answer) => core.replyRequest(answer),
      });
    });
    const running = options.track(
      entry,
      withTimeout(Promise.race([work, aborted]), turnLimits.turnMs),
    );

    function finish(failure?: { error: unknown }) {
      const error = failure?.error;
      run.finished = true;
      run.ended = true;
      try {
        turn.end();
      } catch {
        options.log(`apps: ${assistantAppId} could not close a request's turn`);
      } finally {
        if (error instanceof ActionCallError && error.code === "unavailable") {
          rejectReply(error);
        } else {
          resolveReply(null);
          if (
            failure &&
            !isActionError(error) &&
            !(error instanceof ActionCallError)
          ) {
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
    /**
     * Stops new requests and ends those under way, releasing callers before
     * the HTTP server closes. The windows go with them.
     */
    close() {
      closed = true;
      for (const run of runs.values()) {
        endRun(run, new ActionCallError("unavailable"));
      }
      windows.clear();
    },

    /**
     * The Assistant stops: paused, restarted, removed or without its
     * permission. Its requests end and every device's window goes.
     */
    stopped(entry: InstalledApp) {
      if (entry.app.id !== assistantAppId) return;
      for (const run of runs.values()) {
        endRun(run, new ActionCallError("unavailable"));
      }
      windows.clear();
    },

    /**
     * Runs a request for whoever asked, and resolves with the Assistant's
     * reply, or null when it gave none or a newer request from the same
     * device took over; `unavailable` when it's off.
     */
    async ask(request: {
      actor: TurnOpener;
      who: ActivityAuthor & { clientId: string };
      asked: Omit<AssistantRequest, "earlier">;
      checkClient: () => void;
    }): Promise<RequestReply | null> {
      if (closed) throw new ActionCallError("unavailable");
      const entry = installed.get(assistantAppId);
      if (!entry || !canAnswer(entry)) {
        throw new ActionCallError("unavailable");
      }
      const device = request.who.clientId;
      if (limiter.takeRequest(device)) throw new ActionCallError("limited");

      let release!: () => void;
      const run: Run = {
        device,
        steering: new AbortController(),
        ended: false,
        finished: false,
        tools: new Set(),
        done: new Promise<void>((done) => (release = done)),
      };
      const { signal } = run.steering;
      const previous = runs.get(device);
      runs.set(device, run);
      let slot: { done: () => void } | undefined;
      let dispatched = false;
      const leave = () => {
        slot?.done();
        if (runs.get(device) === run) runs.delete(device);
        release();
      };

      // Taken over before it ran: kept for the next request, unanswered.
      const steeredFirst = () => {
        const reason: unknown = signal.reason;
        if (!(reason instanceof ActionCallError)) throw reason;
        if (reason.code !== "turn_ended") throw reason;
        windows.begin(device, entry.runId, request.asked.text).exchange.cutOff =
          true;
        return null;
      };

      try {
        if (previous) {
          endRun(previous, new ActionCallError("turn_ended"));
          await settled(previous);
        }
        if (signal.aborted) return steeredFirst();
        const admitted = limiter.begin(device);
        if (!("done" in admitted)) throw new ActionCallError("limited");
        slot = admitted;

        if (!accepts(entry)) {
          const arrived = await options.arrives(entry, signal);
          if (signal.aborted) return steeredFirst();
          if (
            !arrived ||
            installed.get(assistantAppId) !== entry ||
            !canAnswer(entry) ||
            !accepts(entry)
          ) {
            throw new ActionCallError("unavailable");
          }
        }
        request.checkClient();
        const { exchange, earlier } = windows.begin(
          device,
          entry.runId,
          request.asked.text,
        );
        run.exchange = exchange;
        const { reply, finished } = dispatch(entry, run, exchange, {
          ...request,
          asked: { ...request.asked, earlier },
        });
        dispatched = true;
        void finished.then(leave, leave);
        return await reply;
      } finally {
        if (!dispatched) leave();
      }
    },
  };
}
