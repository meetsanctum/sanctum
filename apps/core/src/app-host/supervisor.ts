import type { AppFailure, AppRunning } from "@meetsanctum/app-sdk";

import type { ManagerClient } from "../manager.js";
import { ManagerRefusal } from "../manager.js";
import type { InstalledApp } from "./installed.js";

// Keeps an app that runs apart running. Its container starts by the
// manager's hand, and from there: Starting until its start returns; Waiting
// when its start says what it waits for, tried again without counting;
// Running; Restarting after a crash, running out of memory, a hang or a failed
// start, after a pause that grows; and, at the fifth failure in ten minutes,
// failed, until someone restarts it. A pause of its permissions is none of this
// module's business: it runs in the same container (lifecycle.ts).

export type AppContainerManager = Pick<
  ManagerClient,
  | "capabilities"
  | "startAppContainer"
  | "stopAppContainer"
  | "removeAppContainer"
  | "appContainer"
  | "appUsage"
>;

/** How an app apart stands, and what the core keeps of how it got there. */
export type Supervision = {
  phase: "starting" | "waiting" | "running" | "restarting" | "failed";
  since: Date;
  isFirstStart: boolean;
  waitingFor?: string;
  // When it failed, within the last ten minutes.
  failures: number[];
  lastFailure?: AppFailure;
  // How often it has been tried again while waiting.
  retries: number;
  // Down under 30 s, so Home and its pages stay as they were; and waiting long
  // enough to tell someone. Their timers announce when each changes.
  isDown: boolean;
  quiet: boolean;
  attention: boolean;
  quietTimer?: NodeJS.Timeout;
  attentionTimer?: NodeJS.Timeout;
  isEnded: boolean;
  generation: number;
  // The core is ending the connection it has, so hearing it go is no failure,
  // whatever has begun by then.
  endingConnection: boolean;
  // The manager is replacing its container. A container a core before this one
  // started can reach this one's socket, and goes with that, so it isn't started and
  // its going is no failure of the app.
  isReplacing: boolean;
  // Its first start in this core, which takes over a container a core before
  // this one left running as the manager would make it: its runner says hello
  // again, and it starts there.
  mayKeep: boolean;
  // Container changes finish in order, including before removal.
  containerWork?: Promise<void>;
  timer?: NodeJS.Timeout;
  // Calls that wait for it to be back.
  waiters: Set<() => void>;
};

const failuresBeforeGivingUp = 5;
const failureWindowMs = 10 * 60_000;
// After a failure, a pause of each of these in turn.
const defaultRestartPausesMs = [1_000, 5_000, 30_000, 120_000];
// While it waits for something, tried again after each of these, then the last.
const defaultWaitPausesMs = [5_000, 30_000, 120_000, 300_000];
// A container that doesn't say hello by then counts as a failed start. It's a
// new process on a slow card; its own migrations come after hello.
const defaultConnectWithinMs = 60_000;
// Meanwhile, how often the manager is asked whether its container still runs: one
// that has stopped before hello failed its start, and needn't wait out the rest.
const defaultConnectCheckMs = 1_000;
// How long Home and an app's pages stay as they were once it goes down.
const defaultQuietMs = 30_000;
// How long it waits for something before Needs attention says what.
const defaultAttentionMs = 5 * 60_000;
// How long the manager may take to see that a container has stopped.
const howItStoppedWithinMs = 2_000;
// The exit of a process killed outright, as the kernel kills one that ran out
// of memory: 128 and SIGKILL's 9.
const killedExitCode = 137;

export function newSupervision(now: Date): Supervision {
  return {
    phase: "starting",
    since: now,
    isFirstStart: true,
    failures: [],
    retries: 0,
    isDown: false,
    quiet: false,
    attention: false,
    isEnded: false,
    isReplacing: false,
    mayKeep: true,
    generation: 0,
    endingConnection: false,
    waiters: new Set(),
  };
}

const isRunning = (supervision: Supervision) => supervision.phase === "running";

// The pause for this many, or the last when there are more.
const pauseOf = (pauses: readonly number[], count: number) =>
  pauses[Math.min(count, pauses.length - 1)]!;

export function createSupervisor(options: {
  manager: AppContainerManager;
  // Starts the app in the connection it has, once it's ready.
  reconcile: (entry: InstalledApp) => unknown;
  // Its connection has gone, so it no longer runs.
  gone: (entry: InstalledApp) => unknown;
  // Its state changed, for the clients that show it.
  announce: (entry: InstalledApp) => void;
  // It has been down long enough to show, or was given up on.
  settled: (entry: InstalledApp) => void;
  // A new version failed before its commit, which undoes it rather than try again.
  // Whether that took it on.
  updateFailed: (entry: InstalledApp, failure: AppFailure) => boolean;
  // A new version's first start said what it waits for, which gives the slot up.
  updateNotReady: (entry: InstalledApp, waitingFor: string) => boolean;
  log: (message: string) => void;
  now: () => Date;
  restartPausesMs?: readonly number[];
  waitPausesMs?: readonly number[];
  connectWithinMs?: number;
  connectCheckMs?: number;
  quietMs?: number;
  attentionMs?: number;
}) {
  const { manager, reconcile, gone, announce, log, now } = options;
  const quietMs = options.quietMs ?? defaultQuietMs;
  const attentionMs = options.attentionMs ?? defaultAttentionMs;
  const restartPauses = options.restartPausesMs ?? defaultRestartPausesMs;
  const waitPauses = options.waitPausesMs ?? defaultWaitPausesMs;
  const connectWithinMs = options.connectWithinMs ?? defaultConnectWithinMs;
  const connectCheckMs = options.connectCheckMs ?? defaultConnectCheckMs;

  const of = (entry: InstalledApp) => entry.supervision;
  const isCurrent = (entry: InstalledApp, generation: number) =>
    !of(entry).isEnded && of(entry).generation === generation;

  function manage(entry: InstalledApp, work: () => Promise<void>) {
    const supervision = of(entry);
    const result = (supervision.containerWork ?? Promise.resolve()).then(work);
    supervision.containerWork = result.catch(() => undefined);
    return result;
  }

  // The quiet that follows going down, whichever phases it passes through, and
  // what comes of waiting. A restart that fixes itself never shows.
  function follow(entry: InstalledApp, phase: Supervision["phase"]) {
    const supervision = of(entry);
    if (phase !== "starting") supervision.isFirstStart = false;
    const settle = () => {
      clearTimeout(supervision.quietTimer);
      supervision.quietTimer = undefined;
      supervision.quiet = false;
      options.settled(entry);
    };
    if (phase === "running") {
      clearTimeout(supervision.quietTimer);
      supervision.quietTimer = undefined;
      supervision.isDown = false;
      supervision.quiet = false;
    } else if (!supervision.isDown) {
      supervision.isDown = true;
      supervision.quiet = true;
      supervision.quietTimer = setTimeout(() => {
        settle();
        announce(entry);
      }, quietMs);
    }
    if (phase === "failed" && supervision.quiet) {
      settle();
    }
    if (phase !== "waiting") {
      clearTimeout(supervision.attentionTimer);
      supervision.attentionTimer = undefined;
      supervision.attention = false;
    } else if (!supervision.attentionTimer && !supervision.attention) {
      supervision.attentionTimer = setTimeout(() => {
        supervision.attentionTimer = undefined;
        supervision.attention = true;
        announce(entry);
      }, attentionMs);
    }
  }

  function become(
    entry: InstalledApp,
    phase: Supervision["phase"],
    change: Partial<Supervision> = {},
  ) {
    const supervision = of(entry);
    if (supervision.isEnded) return;
    clearTimeout(supervision.timer);
    supervision.timer = undefined;
    const isNew = supervision.phase !== phase;
    Object.assign(supervision, { phase, ...change });
    if (isNew) {
      supervision.since = now();
    }
    follow(entry, phase);
    if (phase === "running" || phase === "failed") {
      for (const wake of supervision.waiters) wake();
      supervision.waiters.clear();
    }
    announce(entry);
  }

  // Nothing may be left of the last run before the next.
  async function stopContainer(entry: InstalledApp) {
    await manage(entry, () => manager.stopAppContainer(entry.app.id)).catch(
      (error: unknown) => {
        log(`apps: ${entry.app.id}'s container didn't stop (${String(error)})`);
      },
    );
  }

  function failed(entry: InstalledApp, failure: AppFailure) {
    const supervision = of(entry);
    if (supervision.isEnded) return;
    if (options.updateFailed(entry, failure)) return;
    if (entry.off) return;
    const generation = ++supervision.generation;
    supervision.endingConnection = entry.link.isConnected();
    const at = now().getTime();
    const failures = [
      ...supervision.failures.filter((when) => at - when < failureWindowMs),
      at,
    ];
    log(`apps: ${entry.app.id} failed (${failure}), ${failures.length} lately`);
    const change = {
      failures,
      lastFailure: failure,
      waitingFor: undefined,
      retries: 0,
    };
    if (failures.length >= failuresBeforeGivingUp) {
      become(entry, "failed", change);
      void stopContainer(entry);
      return;
    }
    become(entry, "restarting", change);
    const pauseMs = pauseOf(restartPauses, failures.length - 1);
    void stopContainer(entry).then(() => {
      if (!isCurrent(entry, generation) || of(entry).phase !== "restarting")
        return;
      of(entry).timer = setTimeout(() => void launch(entry), pauseMs);
    });
  }

  // It says what it waits for; it isn't a failure, and it's tried again by itself.
  function waiting(
    entry: InstalledApp,
    waitingFor: string | undefined,
    again?: () => void,
    pauseMs?: number,
  ) {
    if (of(entry).isEnded || entry.off) return;
    const retries = of(entry).retries;
    become(entry, "waiting", { waitingFor, retries: retries + 1 });
    if (again) {
      of(entry).timer = setTimeout(
        again,
        pauseMs ?? pauseOf(waitPauses, retries),
      );
    }
  }

  // Asks for its container, which says hello in its own time.
  async function launch(entry: InstalledApp) {
    if (of(entry).isEnded || entry.off) return;
    const generation = ++of(entry).generation;
    await of(entry).containerWork;
    if (!isCurrent(entry, generation)) return;
    const { app, apartIn, manifest } = entry;
    become(entry, of(entry).phase === "waiting" ? "waiting" : "starting");
    if (!manager.capabilities().appContainers) {
      waiting(entry, undefined, () => void launch(entry));
      return;
    }
    try {
      await manage(entry, async () => {
        if (!isCurrent(entry, generation)) return;
        of(entry).isReplacing = true;
        // Only the first: a later one follows a failure, or a change that
        // needs a container of its own.
        const keep = of(entry).mayKeep;
        of(entry).mayKeep = false;
        try {
          const { kept } = await manager.startAppContainer(app.id, {
            folder: apartIn,
            memoryMb: manifest.runtime.memory,
            dataMb: manifest.runtime.data,
            ...(keep ? { keep } : {}),
          });
          if (kept) log(`apps: ${app.id} goes on in its container`);
        } finally {
          of(entry).isReplacing = false;
        }
      });
    } catch (error) {
      if (!isCurrent(entry, generation)) return;
      log(`apps: ${app.id}'s container didn't start (${String(error)})`);
      if (error instanceof ManagerRefusal) {
        failed(entry, "failed_start");
      } else {
        waiting(entry, undefined, () => void launch(entry));
      }
      return;
    }
    if (!isCurrent(entry, generation)) return;
    if (entry.link.isReady()) {
      // One that has said what it waits for is asked again after its pause.
      if (!entry.running && !of(entry).waitingFor) ready(entry);
      return;
    }
    awaitHello(entry, generation, performance.now() + connectWithinMs);
  }

  // Until it says hello, by its deadline, asking now and then whether its container
  // still runs. Hello, or anything else that moves it on, clears the timer.
  function awaitHello(entry: InstalledApp, generation: number, by: number) {
    const { id } = entry.app;
    let isChecking = false;
    const isWaiting = () =>
      isCurrent(entry, generation) && !entry.link.isConnected();
    const check = async () => {
      of(entry).timer = undefined;
      if (!isWaiting()) return;
      if (performance.now() >= by) {
        log(`apps: ${id} didn't say hello in time`);
        failed(entry, "failed_start");
        return;
      }
      // A slow status request must neither move the deadline nor pile up requests.
      of(entry).timer = setTimeout(
        () => void check(),
        Math.min(connectCheckMs, Math.max(0, by - performance.now())),
      );
      if (isChecking) return;
      isChecking = true;
      try {
        const container = await manager.appContainer(id).catch(() => undefined);
        if (!isWaiting() || !of(entry).timer) return;
        if (container && container.state !== "running") {
          log(`apps: ${id}'s container stopped before it said hello`);
          clearTimeout(of(entry).timer);
          of(entry).timer = undefined;
          failed(
            entry,
            container.outOfMemory ? "out_of_memory" : "failed_start",
          );
        }
      } finally {
        isChecking = false;
      }
    };
    of(entry).timer = setTimeout(
      () => void check(),
      Math.min(connectCheckMs, connectWithinMs),
    );
  }

  // What stopped it, which the kernel told the manager. It may not know yet just
  // as the socket closes, and Docker may say a process was killed a moment
  // before it says the kernel killed it for its memory.
  async function howItStopped(
    entry: InstalledApp,
    generation: number,
  ): Promise<AppFailure> {
    const started = Date.now();
    while (
      isCurrent(entry, generation) &&
      Date.now() - started < howItStoppedWithinMs
    ) {
      const container = await manager
        .appContainer(entry.app.id)
        .catch(() => undefined);
      if (container?.state === "stopped") {
        if (container.outOfMemory) return "out_of_memory";
        if (container.exitCode !== killedExitCode) return "crashed";
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    return "crashed";
  }

  function ready(entry: InstalledApp) {
    const supervision = of(entry);
    if (
      supervision.isEnded ||
      entry.off ||
      supervision.isReplacing ||
      supervision.phase === "failed" ||
      supervision.phase === "restarting"
    )
      return;
    clearTimeout(supervision.timer);
    supervision.timer = undefined;
    void reconcile(entry);
  }

  return {
    launch,

    /** Its connection is ready: it starts, by its grants. */
    ready,

    /**
     * A paused app, or one whose services changed, is starting again. Whether
     * that was news: it was running until now.
     */
    starting(entry: InstalledApp) {
      if (of(entry).phase !== "running") return false;
      become(entry, "starting");
      return true;
    },

    /**
     * The start it was said to be starting for does not come, as when it is
     * paused again first: it is as it was before.
     */
    calledOff(entry: InstalledApp) {
      if (of(entry).phase === "starting") become(entry, "running");
    },

    /** Its restarts, for its settings. */
    restartsOf(entry: InstalledApp): AppRunning["restarts"] {
      const { failures, lastFailure } = of(entry);
      const at = now().getTime();
      const last = failures.at(-1);
      return {
        recent: failures.filter((when) => at - when < failureWindowMs).length,
        ...(last !== undefined && lastFailure
          ? { last: { at: new Date(last).toISOString(), failure: lastFailure } }
          : {}),
      };
    },

    /** Its start has returned. */
    started(entry: InstalledApp) {
      if (of(entry).phase === "restarting" || of(entry).phase === "failed")
        return;
      become(entry, "running", { waitingFor: undefined, retries: 0 });
    },

    /** Its start says what it waits for. */
    notReady(entry: InstalledApp, waitingFor: string) {
      log(`apps: ${entry.app.id} is waiting: ${waitingFor}`);
      if (options.updateNotReady(entry, waitingFor)) return;
      waiting(entry, waitingFor, () => void reconcile(entry));
    },

    /** It waits for something that isn't its own doing, asking again soon. */
    waits: waiting,

    /** Its start failed, with its connection still there. */
    startFailed(entry: InstalledApp) {
      failed(entry, "failed_start");
    },

    /** Its stop hook failed, so only ending its container ends its code. */
    stopFailed(entry: InstalledApp) {
      failed(entry, "hung");
    },

    /** Its connection went: it crashed, ran out of memory or was found hung. */
    lost(entry: InstalledApp, hung: boolean) {
      if (of(entry).isEnded) return;
      void gone(entry);
      const { phase, endingConnection } = of(entry);
      of(entry).endingConnection = false;
      // Someone turned it off, so its going is what they asked for.
      if (entry.off) return;
      // The core stopped it itself.
      if (endingConnection || phase === "restarting" || phase === "failed") {
        return;
      }
      if (of(entry).isReplacing) {
        become(entry, "starting", { waitingFor: undefined });
        return;
      }
      const generation = ++of(entry).generation;
      become(entry, "restarting");
      void (async () => {
        const failure = hung ? "hung" : await howItStopped(entry, generation);
        if (isCurrent(entry, generation)) failed(entry, failure);
      })();
    },

    /**
     * Someone turned it off: nothing more is tried, what it has been through is
     * forgotten, and its container stops, which frees its memory.
     */
    turnedOff(entry: InstalledApp) {
      const supervision = of(entry);
      if (supervision.isEnded) return;
      supervision.generation += 1;
      supervision.endingConnection = entry.link.isConnected();
      clearTimeout(supervision.timer);
      clearTimeout(supervision.quietTimer);
      clearTimeout(supervision.attentionTimer);
      Object.assign(supervision, {
        phase: "starting",
        since: now(),
        isFirstStart: true,
        waitingFor: undefined,
        failures: [],
        lastFailure: undefined,
        retries: 0,
        isDown: false,
        quiet: false,
        attention: false,
        timer: undefined,
        quietTimer: undefined,
        attentionTimer: undefined,
      });
      for (const wake of supervision.waiters) wake();
      supervision.waiters.clear();
      return stopContainer(entry);
    },

    /** Someone asked for it again after it was given up on. */
    restart(entry: InstalledApp) {
      if (of(entry).isEnded) return;
      of(entry).failures = [];
      of(entry).retries = 0;
      become(entry, "restarting", { waitingFor: undefined });
      return launch(entry);
    },

    /** It's being removed, or the core is closing: nothing more is tried. */
    end(entry: InstalledApp) {
      of(entry).isEnded = true;
      of(entry).generation += 1;
      clearTimeout(of(entry).timer);
      of(entry).timer = undefined;
      clearTimeout(of(entry).quietTimer);
      clearTimeout(of(entry).attentionTimer);
      for (const wake of of(entry).waiters) wake();
      of(entry).waiters.clear();
      return of(entry).containerWork;
    },

    /**
     * Waits for it to be running, within `withinMs`, if it's on its way. A press
     * waits for an app that's restarting rather than fail at once.
     */
    async arrives(entry: InstalledApp, withinMs: number) {
      const supervision = entry.supervision;
      if (
        supervision.isEnded ||
        entry.off ||
        (supervision.phase !== "starting" &&
          supervision.phase !== "waiting" &&
          supervision.phase !== "restarting")
      ) {
        return false;
      }
      let timer: NodeJS.Timeout | undefined;
      let wake: () => void = () => undefined;
      await new Promise<void>((done) => {
        wake = done;
        supervision.waiters.add(done);
        timer = setTimeout(done, withinMs);
      });
      clearTimeout(timer);
      supervision.waiters.delete(wake);
      return !supervision.isEnded && isRunning(supervision);
    },
  };
}

export type Supervisor = ReturnType<typeof createSupervisor>;
