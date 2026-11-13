import {
  coreEventNames,
  isNotReady,
  pausedBy,
  type AppContext,
  type StartInfo,
  type StopInfo,
} from "@meetsanctum/app-sdk";

import type { Devices } from "../devices/devices.js";
import type { Presses } from "../devices/presses.js";
import type { Entities } from "../entities/entities.js";
import type { People } from "../people/people.js";
import type { PlacesModule } from "../places/places.js";
import { stopLimitMs } from "./apart.js";
import { appStateOf } from "./app-info.js";
import { newAppUpdate, type AppCommits } from "./commits.js";
import type { AppContexts } from "./contexts.js";
import type { CoreEvents } from "./core-events.js";
import { TimedOut, withTimeout } from "./errors.js";
import { createEventStorage } from "./event-storage.js";
import type { InstalledApp } from "./installed.js";
import { createReadSnapshot } from "./snapshot.js";
import type { Supervisor } from "./supervisor.js";
import type { AppUpdates } from "./updates.js";

// An app's starts and stops. It is paused while a permission it needs is
// switched off: it stops, and its actions, jobs and driver calls are refused
// until it is back on. It starts once its socket's connection is ready, and
// stops when that goes, which needs no hook; its supervisor does the rest
// (supervisor.ts).

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// Its supervisor has it restarting or has given up on it, which it may have
// done during anything awaited.
const isInSupervisorsHands = (entry: InstalledApp) =>
  entry.supervision.phase === "restarting" ||
  entry.supervision.phase === "failed";

export function createAppLifecycle(options: {
  installed: ReadonlyMap<string, InstalledApp>;
  coreEvents: CoreEvents;
  contexts: AppContexts;
  people: Pick<People, "list">;
  places: Pick<PlacesModule, "list" | "location">;
  devices: Devices;
  entities: Entities;
  presses: () => Pick<Presses, "endCaptures">;
  updates: Pick<AppUpdates, "startOf">;
  commits: AppCommits;
  supervisor: () => Supervisor;
  timeoutMs: number;
  log: (message: string) => void;
}) {
  const { installed, coreEvents, contexts, timeoutMs, log } = options;
  let lastRunId = 0;

  // Whether the app takes calls now: it runs and is not paused.
  function accepts(entry: InstalledApp) {
    return Boolean(entry.running) && appStateOf(entry) === "running";
  }

  // Runs a lifecycle hook with a timeout. A hook that fails is logged, and
  // the app and the others go on. Answers whether the hook ran to its end,
  // and what it waits for if it didn't and said so.
  async function hook(
    entry: InstalledApp,
    name: "start" | "stop",
    ctx: AppContext,
    info: StartInfo | StopInfo,
  ): Promise<{ ok: boolean; notReady?: string }> {
    const run = entry.app[name] as
      | ((ctx: AppContext, info: StartInfo | StopInfo) => Promise<void>)
      | undefined;
    if (!run) {
      return { ok: true };
    }
    try {
      await withTimeout(
        Promise.resolve().then(() => run.call(entry.app, ctx, info)),
        name === "stop" ? stopLimitMs(timeoutMs) : timeoutMs,
      );
      return { ok: true };
    } catch (error) {
      if (isNotReady(error)) {
        return { ok: false, notReady: error.message };
      }
      log(
        `apps: ${entry.app.id} did not ${name} (${error instanceof TimedOut ? "timed out" : message(error)})`,
      );
      return { ok: false };
    }
  }

  async function startApp(entry: InstalledApp) {
    const { app, link } = entry;
    if (entry.off) {
      return;
    }
    // Its connection's being ready brings it back here.
    if (
      !link.isReady() ||
      entry.supervision.isEnded ||
      isInSupervisorsHands(entry)
    ) {
      return;
    }
    options.supervisor().starting(entry);
    const storage = createEventStorage(entry.storage, timeoutMs);
    // These two are one moment: what it reads while it starts, and the first
    // of the events it hears after.
    const snapshot = createReadSnapshot(options);
    const following = coreEvents.start(
      app.id,
      () => entry.granted,
      // It starts again, and catches up, as it does after any stop.
      () => void reconcile(entry, { restartFor: "its events' backlog" }),
      (work) =>
        storage.run(() => {
          // A pause can arrive before a slow start releases queued events.
          if (accepts(entry)) return work();
        }),
    );
    const ctx: AppContext = contexts.contextFor(
      entry,
      { kind: "app", id: app.id },
      storage,
      { following, snapshot },
    );
    // The core hands each event it follows across its socket. Its own handlers
    // are on the other side.
    const across = (event: unknown) =>
      link.call(
        contexts.coreOf(ctx),
        ctx.actor,
        { kind: "event", event: event as never },
        timeoutMs,
      ) as Promise<void>;
    for (const name of coreEventNames) {
      following.handlers.set(name, [across]);
    }
    entry.running = { ctx, storage };
    lastRunId += 1;
    entry.runId = lastRunId;
    const { info, update } = options.updates.startOf(entry);
    // Each try claims afresh.
    entry.updating =
      update || info.reason === "updated" ? newAppUpdate(update) : undefined;
    let outcome = await hook(entry, "start", ctx, info);
    snapshot.release();
    if (outcome.ok) {
      try {
        options.commits.commit(entry);
        options.supervisor().started(entry);
      } catch (error) {
        log(`apps: ${app.id} did not commit (${message(error)})`);
        outcome = { ok: false };
      }
    }
    following.started();
    if (outcome.ok) {
      return;
    }
    // It isn't left half started: what that start was given ends, and its
    // supervisor decides what comes next. One whose connection went has been
    // seen to already.
    await stopApp(entry, { reason: "restarting", gone: true });
    if (!link.isReady() || isInSupervisorsHands(entry)) return;
    if (outcome.notReady !== undefined) {
      options.supervisor().notReady(entry, outcome.notReady);
    } else {
      options.supervisor().startFailed(entry);
    }
  }

  // It takes no more calls, and what it set going ends: its pages'
  // captures of presses and its requests to the internet. The core's events
  // stop, the one the app is handling and, unless the core is shutting
  // down, its calls under way finish; then its stop hook runs and every
  // context it had ends. A stop hook that fails ends its container, so
  // whatever its code was doing ends too. One whose connection has gone has
  // no hook to run, and starts again with a new connection.
  async function stopApp(
    entry: InstalledApp,
    { reason, gone = false }: { reason: StopInfo["reason"]; gone?: boolean },
  ) {
    const shutdown = reason === "shutdown";
    const running = entry.running;
    if (!running) {
      return;
    }
    entry.running = undefined;
    options.presses().endCaptures(entry.app.id);
    entry.requests.end();
    await coreEvents.stop(entry.app.id);
    if (!shutdown) {
      await Promise.allSettled([...entry.calls]);
    }
    const stopped =
      gone || (await hook(entry, "stop", running.ctx, { reason })).ok;
    running.storage.end();
    if (!stopped && !shutdown) options.supervisor().stopFailed(entry);
  }

  // Starts or stops the app to match its grants, after its last start or
  // stop: paused while a permission it needs is off, started again once
  // every one is back on, and restarted when a service it may do without
  // changed, since a connection it holds would outlive the change. One
  // removed meanwhile stays stopped. A start or stop that fails is logged and holds up nothing else, so the
  // chain never rejects.
  //
  // It is starting from the moment a start is what comes next, though a stop
  // comes or ends first: once its permissions are all back on, while the stop
  // of its pause may still be under way, and as it stops to restart. So it
  // never shows as running while it takes no calls. One paused again before
  // that start came is as a paused app is.
  function reconcile(
    entry: InstalledApp,
    { restartFor }: { restartFor?: string } = {},
  ) {
    const previousSince = entry.supervision.since;
    const isStartPending =
      installed.get(entry.app.id) === entry &&
      !entry.off &&
      !entry.running &&
      pausedBy(entry.manifest.permissions, entry.granted).length === 0 &&
      options.supervisor().starting(entry);
    const change = async () => {
      if (installed.get(entry.app.id) !== entry) {
        return;
      }
      const off = pausedBy(entry.manifest.permissions, entry.granted);
      try {
        if (entry.off) {
          if (entry.running) {
            log(`apps: ${entry.app.id} is turned off`);
            await stopApp(entry, { reason: "off" });
          }
        } else if (off.length > 0 && entry.running) {
          log(`apps: ${entry.app.id} pauses while ${off.join(", ")} is off`);
          await stopApp(entry, { reason: "paused" });
        } else if (off.length === 0) {
          if (restartFor && entry.running) {
            log(`apps: ${entry.app.id} restarts for ${restartFor}`);
            options.supervisor().starting(entry);
            await stopApp(entry, { reason: "restarting" });
          }
          if (!entry.running) {
            await startApp(entry);
          }
        } else if (off.length > 0) {
          if (isStartPending)
            options.supervisor().calledOff(entry, previousSince);
          log(`apps: ${entry.app.id} is paused while ${off.join(", ")} is off`);
        }
      } catch (error) {
        log(`apps: ${entry.app.id} did not change state (${message(error)})`);
      }
    };
    entry.lifecycle = entry.lifecycle.then(change);
    return entry.lifecycle;
  }

  return {
    accepts,
    stopApp,
    reconcile,

    // Its connection went, after what its lifecycle is already doing.
    gone(entry: InstalledApp) {
      entry.lifecycle = entry.lifecycle
        .then(() => stopApp(entry, { reason: "restarting", gone: true }))
        .catch((error: unknown) => {
          log(`apps: ${entry.app.id} did not change state (${message(error)})`);
        });
      return entry.lifecycle;
    },
  };
}
