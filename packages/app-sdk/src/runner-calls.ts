import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

import {
  createAppContext,
  type AppContext,
  type CoreCalls,
} from "./context.js";
import type {
  CoreEvent,
  CoreEventHandler,
  CoreEventHandlers,
} from "./core-events.js";
import type { DriverCommand, DriverMove } from "./devices.js";
import type { DriverDevice } from "./firmware.js";
import {
  isActionError,
  isNotReady,
  type ActionDefinition,
  type Actor,
  type AppDefinition,
  type StartInfo,
  type StopInfo,
} from "./index.js";
import type { DriverRemoval } from "./pairing.js";
import {
  coreCallMethods,
  failureOf,
  type CallMessage,
  type CoreCallMethod,
  type DriverHook,
  type Outcome,
} from "./protocol.js";
import type { AppStorage } from "./storage.js";

// What a runner does with the calls the core makes: it runs the app's code,
// one context per call. Each
// context's database calls stay here, and everything else crosses the socket
// naming the call it belongs to. A call's transaction ends with it: its time
// running out, or its end, rolls back what it left open.

type StorageCall = ReturnType<AppStorage["call"]>;
type Scope = { id: string; storage: StorageCall };

// The context from `start` until `stop`, which the app's handlers close over.
type Running = {
  ctx: AppContext;
  lifetime: Scope;
  handlers: CoreEventHandlers;
};

type Hook = (ctx: AppContext, params: unknown) => Promise<unknown>;
type Driver = NonNullable<AppDefinition["driver"]>;

// Each hook of the Drivers contract, when the driver has it. They are methods
// on the app's own objects, so each is called on them.
const driverHooks: Record<DriverHook, (driver: Driver) => Hook | undefined> = {
  command: (driver) => (ctx, params) =>
    driver.command(ctx, params as DriverCommand),
  move: (driver) =>
    driver.move && ((ctx, params) => driver.move!(ctx, params as DriverMove)),
  "pairing.open": ({ pairing }) =>
    pairing &&
    ((ctx, params) => pairing.open(ctx, params as { seconds: number })),
  "pairing.close": ({ pairing }) => pairing && ((ctx) => pairing.close(ctx)),
  remove: (driver) =>
    driver.remove &&
    ((ctx, params) => driver.remove!(ctx, params as DriverRemoval)),
  "firmware.check": ({ firmware }) =>
    firmware && ((ctx, params) => firmware.check(ctx, params as DriverDevice)),
  "firmware.update": ({ firmware }) =>
    firmware && ((ctx, params) => firmware.update(ctx, params as DriverDevice)),
  "firmware.stop": ({ firmware }) =>
    firmware && ((ctx, params) => firmware.stop(ctx, params as DriverDevice)),
  probe: (driver) =>
    driver.probe &&
    ((ctx, params) => driver.probe!(ctx, params as DriverDevice)),
};

// How work ended. A refusal keeps its code; anything else is the app's failure.
async function outcomeOf(work: () => unknown): Promise<Outcome> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (isNotReady(error)) {
      return failureOf(error, "not_ready");
    }
    return isActionError(error)
      ? failureOf(error, error.code)
      : failureOf(error);
  }
}

// Whether work settles within its time. It goes on after that either way.
async function within(work: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    work.then(() => true),
    new Promise<boolean>((done) => {
      timer = setTimeout(done, ms, false);
    }),
  ]);
  clearTimeout(timer);
  return settled;
}

// What the app's own schema makes of a value. A schema's transform or
// refinement is app code too, and may throw instead of answering.
function parsed(schema: z.ZodType, value: unknown) {
  try {
    return { result: schema.safeParse(value) };
  } catch (error) {
    return { threw: error };
  }
}

export function createCallHost(options: {
  app: AppDefinition;
  storage: AppStorage;
  /** Carries one of the app's calls to the core, naming the call it belongs to. */
  request: (
    call: string,
    method: CoreCallMethod,
    params: unknown[],
    hasEnded: () => boolean,
  ) => Promise<unknown>;
  answer: (call: string, outcome: Outcome) => void;
  log: (message: string) => void;
}) {
  const { app, storage } = options;
  const appId = app.id;
  const actions = new Map<string, ActionDefinition>(
    app.actions.map((action) => [action.id, action]),
  );
  // The delivery of a core's event that is under way, followed across awaits
  // and the work it sets off, so a handler that runs late can't reach into the
  // start context's call or the next delivery's.
  const delivering = new AsyncLocalStorage<Scope>();
  let running: Running | undefined;
  let stopping: Promise<Outcome> | undefined;
  // The calls under way, which end with the connection they came on.
  const open = new Set<Scope>();
  // A start hook under way, which a stop never overlaps.
  let starting: Promise<unknown> | undefined;

  // Nothing reaches the app before `start` returns or its time runs out: calls
  // wait here, within their own time limit.
  let opened: () => void = () => undefined;
  let afterStart = new Promise<void>((open) => (opened = open));

  function callsOf(current: () => Scope, lifetime?: Scope): CoreCalls {
    const remote = Object.fromEntries(
      coreCallMethods.map((method) => [
        method,
        async (...params: unknown[]) => {
          const scope = current();
          const hasEnded = () =>
            scope.storage.ended || lifetime?.storage.ended === true;
          if (hasEnded()) {
            throw new Error(`This call to ${appId} has ended`);
          }
          return options.request(scope.id, method, params, hasEnded);
        },
      ]),
    );
    return {
      ...remote,
      query: (query) => current().storage.query(query),
      log: options.log,
    } as CoreCalls;
  }

  // Runs work as a call of its own, whose storage ends with it or when its
  // time runs out. App code goes on after that, since JavaScript cannot stop
  // it, but it changes nothing more.
  async function inCall<T>(
    id: string,
    deadlineMs: number,
    work: (scope: Scope) => Promise<T>,
  ) {
    const scope = { id, storage: storage.call() };
    open.add(scope);
    const timer = setTimeout(() => scope.storage.end(), deadlineMs);
    try {
      return await work(scope);
    } finally {
      clearTimeout(timer);
      scope.storage.end();
      open.delete(scope);
    }
  }

  const contextOf = (scope: Scope, actor: Actor) =>
    createAppContext({
      appId,
      actor,
      app,
      core: callsOf(() => scope),
    });

  async function start(
    id: string,
    actor: Actor,
    deadlineMs: number,
    info: StartInfo,
    update?: string,
  ) {
    const arrived = Date.now();
    // A stop under way finishes first, so the two hooks never overlap.
    if (stopping && !(await within(stopping, deadlineMs))) {
      return failureOf(`${appId} was still stopping`);
    }
    if (running) {
      return failureOf(`${appId} has already started`);
    }
    const open = opened;
    const lifetime = { id, storage: storage.call() };
    const handlers: CoreEventHandlers = new Map();
    const ctx = createAppContext({
      appId,
      actor,
      app,
      handlers,
      core: callsOf(() => delivering.getStore() ?? lifetime, lifetime),
    });
    running = { ctx, lifetime, handlers };
    const timer = setTimeout(open, deadlineMs - (Date.now() - arrived));
    const work = outcomeOf(async () => {
      await app.start?.(ctx, info);
      // The core commits an update on this, so it has to be on the disk first.
      if (update) {
        await storage.sync();
        return { synced: update };
      }
    });
    starting = work;
    const outcome = await work;
    if (starting === work) starting = undefined;
    clearTimeout(timer);
    // One that isn't ready hasn't started: nothing reaches it, and the core
    // calls this again when it tries again.
    if (!outcome.ok && outcome.code === "not_ready") {
      running = undefined;
      lifetime.storage.end();
      return outcome;
    }
    open();
    return outcome;
  }

  function stop(deadlineMs: number, info: StopInfo) {
    const current = running;
    if (!current) {
      return stopping ?? Promise.resolve<Outcome>({ ok: true });
    }
    running = undefined;
    // It can start again, and nothing reaches it until it has.
    afterStart = new Promise<void>((open) => (opened = open));
    const { lifetime, ctx } = current;
    const timer = setTimeout(() => lifetime.storage.end(), deadlineMs);
    stopping = outcomeOf(async () => {
      await app.stop?.(ctx, info);
    }).finally(() => {
      clearTimeout(timer);
      lifetime.storage.end();
      stopping = undefined;
    });
    return stopping;
  }

  async function action(
    { id, actor }: CallMessage,
    deadlineMs: number,
    actionId: string,
    rawInput: unknown,
  ): Promise<Outcome> {
    const declared = actions.get(actionId);
    if (!declared) {
      return failureOf(`${appId} has no action ${actionId}`, "not_found");
    }
    const input = parsed(declared.input, rawInput);
    if (!input.result) {
      return failureOf(
        `${declared.id}'s schema failed: ${String(input.threw)}`,
      );
    }
    if (!input.result.success) {
      return failureOf(z.prettifyError(input.result.error), "invalid_request");
    }
    const data = input.result.data;
    const outcome = await inCall(id, deadlineMs, (scope) =>
      outcomeOf(() => declared.run(contextOf(scope, actor), data as never)),
    );
    if (!outcome.ok) {
      return outcome;
    }
    const output = parsed(declared.output, outcome.value);
    if (!output.result?.success) {
      return failureOf(
        `${declared.id} returned something its output schema refuses`,
      );
    }
    return { ok: true, value: output.result.data };
  }

  function driverCall(
    { id, actor }: CallMessage,
    deadlineMs: number,
    hook: DriverHook,
    params: unknown,
  ): Promise<Outcome> {
    const run = app.driver && driverHooks[hook](app.driver);
    if (!run) {
      return Promise.resolve(
        failureOf(`${appId} has no driver hook ${hook}`, "unavailable"),
      );
    }
    return inCall(id, deadlineMs, (scope) =>
      outcomeOf(() => run(contextOf(scope, actor), params)),
    );
  }

  // Each of the app's handlers in turn, the first failure answering for them
  // all: one that fails holds up nothing else.
  async function deliver(id: string, deadlineMs: number, event: CoreEvent) {
    const handlers = (running?.handlers.get(event.name) ??
      []) as CoreEventHandler[];
    const deadline = Date.now() + deadlineMs;
    let failure: Outcome | undefined;
    for (const handler of handlers) {
      const left = deadline - Date.now();
      if (left <= 0) {
        return failure ?? failureOf(`${event.name} ran out of time`);
      }
      const outcome = await inCall(id, left, (scope) =>
        outcomeOf(() => delivering.run(scope, () => handler(event))),
      );
      if (!outcome.ok) {
        failure ??= outcome;
      }
    }
    return failure ?? { ok: true as const };
  }

  async function handle(message: CallMessage): Promise<Outcome> {
    const { id, actor, deadlineMs, body } = message;
    if (body.kind === "start") {
      const { reason, from, update } = body;
      return start(
        id,
        actor,
        deadlineMs,
        reason === "updated" || reason === "rolledBack"
          ? { reason, from: from! }
          : { reason },
        update,
      );
    }
    // With nothing running there is nothing to stop, and a stop under way
    // answers for this one too. Neither waits for a start.
    if (body.kind === "stop" && !running) {
      return stopping ?? { ok: true };
    }
    const arrived = Date.now();
    const started = await within(afterStart, deadlineMs);
    const left = deadlineMs - (Date.now() - arrived);
    if (!started || left <= 0) {
      return failureOf(`${appId} had not started in time`);
    }
    switch (body.kind) {
      case "stop":
        return stop(left, { reason: body.reason });
      case "action":
        return action(message, left, body.action, body.input);
      case "driver":
        return driverCall(message, left, body.hook, body.params);
      case "event":
        return deliver(id, left, body.event);
    }
  }

  return {
    /**
     * Takes one call from the core, and answers it whenever it ends, on the
     * connection it came by.
     */
    take(
      message: CallMessage,
      answer: (outcome: Outcome) => void = (outcome) =>
        options.answer(message.id, outcome),
    ) {
      void handle(message)
        .catch((error: unknown) => failureOf(error))
        .then(answer);
    },

    /**
     * The connection to the core has gone, with every call on it: what they
     * left open rolls back, and nothing of theirs reaches the next core, whose
     * calls may have the same ids. The app stops as for a restart, and starts
     * again when that core calls its start. Whether it stopped within `capMs`
     * without failing.
     */
    async lost(capMs: number) {
      const deadline = Date.now() + capMs;
      for (const scope of open) scope.storage.end();
      open.clear();
      // A start the core no longer waits for finishes first, so the stop that
      // follows finds what it set going.
      if (starting && !(await within(starting, capMs))) return false;
      const left = deadline - Date.now();
      const stopped = running
        ? stop(left, { reason: "restarting" })
        : (stopping ?? Promise.resolve<Outcome>({ ok: true }));
      let outcome: Outcome | undefined;
      const settled = await within(
        stopped.then((each) => {
          outcome = each;
        }),
        left,
      );
      return settled && outcome?.ok === true;
    },

    // A stop nobody called for, as when the container is stopped: its hook is a
    // courtesy, given `capMs` before the process goes.
    async shutdown(capMs: number) {
      const stopped = running ? stop(capMs, { reason: "shutdown" }) : stopping;
      if (stopped) {
        await within(stopped, capMs);
      }
    },
  };
}
