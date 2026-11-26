import {
  aiAssistantPermission,
  assistantAppId,
  isActionError,
  turnLimits,
  type Actor,
  type AssistantRequest,
  type AssistantRequestInput,
  type RequestContext,
  type RequestReply,
} from "@meetsanctum/app-sdk";

import type { ActivityAuthor } from "../activity/activity.js";
import type { TurnOpener } from "../agents/assistants.js";
import { createAgentLimiter } from "../agents/limits.js";
import type { Turn } from "../models/turns.js";
import { appStateOf } from "./app-info.js";
import type { ToolRecorder } from "./contexts.js";
import { ActionCallError, TimedOut, withTimeout } from "./errors.js";
import type { InstalledApp } from "./installed.js";
import { createRequestWindows, type Exchange } from "./request-window.js";

// A request, typed on a client or said to a smart speaker, runs the
// Assistant's handler within a turn for whoever asked. The reply goes back as
// soon as the handler gives it. The turn and its admission slot stay open
// until the handler finishes or its time is up.
//
// Each client and each smart speaker is a conversation of its own, by its
// key: the client's id, or the speaker's device id. A newer request from it
// takes over from one still running: that one's turn ends, its signal aborts
// and its later calls are refused `turn_ended`. Its tool calls under way
// can't be pulled back, so the newer one waits up to 2 s for them to settle,
// and gets it in `earlier` with the other recent exchanges there
// (request-window.ts). Limits count by the same key.

/** How long a newer request waits for the tool calls of the one it ends. */
export const settleWithinMs = 2_000;

type Run = {
  // Its client's id, or its smart speaker's device id.
  device: string;
  // Aborts when a newer request takes over, the deadline expires, or the
  // Assistant stops.
  steering: AbortController;
  // Its turn's calls are refused from here on.
  ended: boolean;
  // Its handler is done, by itself or as its turn ended.
  finished: boolean;
  exchange?: Exchange;
  discarded?: true;
  previous?: Run;
  // Its tool calls under way.
  tools: Set<Promise<void>>;
  settling?: Promise<void>;
  // Settles once its slot is free.
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
    actor: Actor,
    scope: { readonly ended: boolean },
    within: {
      withinMs: number;
      turn: Turn;
      reply: (reply: RequestReply) => void;
      recordTool: ToolRecorder;
      opener: TurnOpener;
      requestClientId: string;
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
  // Leave room for other clients and speakers when one has a request under
  // way.
  const limiter = createAgentLimiter({
    agentPerMinute: 12,
    homePerMinute: 60,
    agentAtOnce: 1,
    homeAtOnce: 4,
  });
  const windows = createRequestWindows();
  let historyGeneration = 0;
  // The request of each device, running or about to.
  const runs = new Map<string, Run>();

  // Every window goes, including what a request still waiting would have
  // added.
  function clearWindows() {
    historyGeneration += 1;
    windows.clear();
  }

  // The Assistant or the core stops: its requests end, and every window goes.
  function stopRequests() {
    clearWindows();
    for (const run of runs.values()) {
      endRun(run, new ActionCallError("unavailable"));
    }
  }

  function canAnswer(entry: InstalledApp) {
    const state = appStateOf(entry);
    return (
      state !== "off" &&
      state !== "paused" &&
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

  // A newer request gives the older one's tools up to 2 s to settle.
  function toolsSettled(run: Run) {
    return (run.settling ??= (async () => {
      if (run.tools.size === 0) return;
      const { waited, clear } = delay(settleWithinMs);
      await Promise.race([Promise.allSettled([...run.tools]), waited]);
      clear();
    })());
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
    let rejectReply!: (error: unknown) => void;
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
    // A speaker is no actor, so the Assistant's other calls are its own;
    // its tools act for the speaker.
    const opener = request.actor;
    const ctx = options.contextFor(
      entry,
      opener.kind === "device" ? { kind: "app", id: assistantAppId } : opener,
      {
        get ended() {
          return run.ended;
        },
      },
      {
        withinMs: turnLimits.turnMs,
        turn,
        opener,
        requestClientId: run.device,
        reply(answer) {
          if (answered) throw new Error("A request is answered once");
          answered = true;
          windows.reply(exchange, answer.text);
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
      const interrupted = signal.aborted;
      run.finished = true;
      run.ended = true;
      if (error instanceof TimedOut) {
        endRun(run, new ActionCallError("turn_ended"));
      }
      try {
        turn.end();
      } catch {
        options.log(`apps: ${assistantAppId} could not close a request's turn`);
      } finally {
        if (
          (error instanceof ActionCallError && error.code === "unavailable") ||
          (failure && opener.kind === "device" && !interrupted)
        ) {
          rejectReply(error);
        } else {
          resolveReply(null);
        }
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
      stopRequests();
    },

    /**
     * The Assistant stops: paused, restarted, removed or without its
     * permission. Its requests end and every device's window goes.
     */
    stopped(entry: InstalledApp) {
      if (entry.app.id !== assistantAppId) return;
      stopRequests();
    },

    /**
     * Something AI agents could use was switched off: every window goes, so
     * no later request carries what the Assistant heard through it.
     */
    clearWindows,

    /**
     * A smart speaker went: its request under way ends, and its window
     * goes.
     */
    forget(key: string) {
      for (let run = runs.get(key); run; run = run.previous) {
        run.discarded = true;
        endRun(run, new ActionCallError("turn_ended"));
      }
      windows.drop(key);
    },

    /** Whether the Assistant is there to answer requests now. */
    answers() {
      const entry = installed.get(assistantAppId);
      return !closed && entry !== undefined && canAnswer(entry);
    },

    /** Whether a request from a client or speaker is within its limits now. */
    hasRoom(key: string) {
      return limiter.hasRoom(key);
    },

    /**
     * Runs a request for whoever asked, and resolves with the Assistant's
     * reply, or null when it gave none or a newer request from the same
     * client or speaker took over. A failure before a spoken reply is
     * handed back to the speaker, and an unavailable Assistant fails either.
     */
    async ask(request: {
      actor: TurnOpener;
      // Its client's id, or its smart speaker's device id.
      key: string;
      who: ActivityAuthor;
      asked: AssistantRequestInput;
      // Checks, just before it runs, that whoever asked may still.
      check?: () => void;
      // A speaker stopped or a newer wake took over before the next ask.
      signal?: AbortSignal;
    }): Promise<RequestReply | null> {
      if (closed) throw new ActionCallError("unavailable");
      const entry = installed.get(assistantAppId);
      if (!entry || !canAnswer(entry)) {
        throw new ActionCallError("unavailable");
      }
      const device = request.key;
      if (limiter.takeRequest(device)) throw new ActionCallError("limited");
      const generation = historyGeneration;

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
      run.previous = previous;
      runs.set(device, run);
      const interrupt = () => endRun(run, new ActionCallError("turn_ended"));
      request.signal?.addEventListener("abort", interrupt, { once: true });
      if (request.signal?.aborted) interrupt();
      let slot: { done: () => void } | undefined;
      let dispatched = false;
      const leave = () => {
        slot?.done();
        request.signal?.removeEventListener("abort", interrupt);
        const remove = () => {
          if (runs.get(device) === run) runs.delete(device);
        };
        if (run.tools.size > 0) void toolsSettled(run).then(remove);
        else remove();
        release();
      };

      // Taken over before it ran: kept for the next request, unanswered.
      const steeredFirst = () => {
        const reason: unknown = signal.reason;
        if (!(reason instanceof ActionCallError)) throw reason;
        if (reason.code !== "turn_ended") throw reason;
        if (!run.discarded && generation === historyGeneration) {
          windows.begin(
            device,
            entry.runId,
            request.asked.text,
          ).exchange.cutOff = true;
        }
        return null;
      };

      try {
        if (previous) {
          endRun(previous, new ActionCallError("turn_ended"));
          await toolsSettled(previous);
          await previous.done;
          run.previous = undefined;
        }
        if (signal.aborted) return steeredFirst();
        const admitted = limiter.begin(device);
        if (!("done" in admitted)) throw new ActionCallError("limited");
        slot = admitted;

        if (!accepts(entry)) {
          const arrived = await options.arrives(entry, signal);
          if (signal.aborted) return steeredFirst();
          if (!arrived) throw new ActionCallError("unavailable");
        }
        if (
          installed.get(assistantAppId) !== entry ||
          !canAnswer(entry) ||
          !accepts(entry)
        ) {
          throw new ActionCallError("unavailable");
        }
        request.check?.();
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
