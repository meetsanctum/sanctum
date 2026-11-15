// The core's lifecycle: the phases it goes through, who it answers, and the
// steps each phase runs, in order (core.ts lists them). Whoever adds something
// that starts or stops with the core adds a step to a phase, and the log says
// each one as it runs.
//
// - starting: as the process starts. Its steps run in order; what a step sets
//   up holds once it has finished, not before.
// - running: once the last step of starting has finished, which listens.
//   Background work of starting, such as installing the apps, may still be
//   under way: it isn't a barrier.
// - stopping: on a signal or a fatal failure. No new work starts, from its
//   first moment, before anything is awaited; then each step is tried in
//   order, even after one fails.
// - stopped: every step of stopping has been tried, not necessarily done. The
//   exit says which failed.
//
// A fatal failure, a step of starting or background work that fails, stops
// the core with exit code 1, so Docker starts it again and a core on trial is
// rolled back. A crash or a power cut skips stopping.

type Log = (message: string) => void;

export const corePhases = [
  "starting",
  "running",
  "stopping",
  "stopped",
] as const;
export type CorePhase = (typeof corePhases)[number];

// The only ways through: starting can also go straight to stopping.
const nextPhases: Record<CorePhase, readonly CorePhase[]> = {
  starting: ["running", "stopping"],
  running: ["stopping"],
  stopping: ["stopped"],
  stopped: [],
};

// Who the core answers: everyone, or only its health check while a core
// update is on trial, from the first request until the manager commits it. A
// rollback never commits: the manager removes the core on trial.
export type CoreReadiness = "healthOnly" | "everyone";

// What a step does, in a few words for the log, and the step. Each is handed
// a signal that stopping aborts, for whatever a step of starting waits on.
export type CoreStep = readonly [
  label: string,
  run: (cancelled: AbortSignal) => void | Promise<void>,
];

export type CoreSteps = {
  // In order; the core runs once the last has finished.
  starting: readonly CoreStep[];
  // At stopping's first moment, before anything is awaited, so that nothing
  // new starts while the core stops.
  stopNewWork: readonly (readonly [label: string, run: () => void])[];
  // In order; each is tried even after one before it failed.
  stopping: readonly CoreStep[];
};

export type CoreExit = { code: 0 | 1; failedSteps: string[] };

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createCoreLifecycle(options: { log: Log }) {
  const { log } = options;
  let phase: CorePhase = "starting";
  let readiness: CoreReadiness = "everyone";
  let steps: CoreSteps | undefined;
  let failed = false;
  const failedSteps: string[] = [];
  // Aborted as stopping begins: starting's steps and its background work.
  const stopStarting = new AbortController();
  // The step of starting under way, which stopping waits for.
  let underWay: Promise<unknown> = Promise.resolve();
  let stopping: Promise<CoreExit> | undefined;
  let exited!: (exit: CoreExit) => void;
  const stopped = new Promise<CoreExit>((resolve) => (exited = resolve));

  function enter(next: CorePhase) {
    if (!nextPhases[phase].includes(next)) {
      throw new Error(`the core can't go from ${phase} to ${next}`);
    }
    phase = next;
  }

  function fail(label: string, error: unknown) {
    failed = true;
    failedSteps.push(label);
    log(`core: ${label} failed (${message(error)})`);
  }

  const lifecycle = {
    phase: () => phase,
    readiness: () => readiness,
    // Resolves once the core has stopped, however it came to stop.
    stopped,

    // An update of the core is on trial, which only starting can find.
    beginTrial() {
      if (phase !== "starting") {
        throw new Error(`a core that's ${phase} can't begin a trial`);
      }
      readiness = "healthOnly";
      log("core: on trial");
    },

    // The manager committed the update: everyone gets an answer from now on.
    commit() {
      if (readiness === "everyone") return;
      readiness = "everyone";
      log("core: the update committed");
    },

    // Runs starting's steps, then the core runs. A step that fails stops the
    // core; one that fails because stopping began meanwhile doesn't count.
    async start(table: CoreSteps) {
      if (steps) throw new Error("the core starts once");
      steps = table;
      log("core: starting");
      for (const [label, run] of table.starting) {
        if (phase !== "starting") return;
        log(`core: starting: ${label}`);
        const step = (async () => run(stopStarting.signal))();
        underWay = step.catch(() => undefined);
        try {
          await step;
        } catch (error) {
          if (phase !== "starting") return;
          fail(label, error);
          void lifecycle.stop("failure");
          return;
        }
      }
      if (phase !== "starting") return;
      enter("running");
      log("core: running");
    },

    // Work of starting that goes on in the background, such as installing the
    // apps: stopping aborts its signal, and its failure is fatal, wherever it
    // happens.
    ownBackgroundTask(
      label: string,
      task: (cancelled: AbortSignal) => Promise<void>,
    ) {
      void (async () => task(stopStarting.signal))().catch((error: unknown) => {
        fail(label, error);
        if (phase === "starting" || phase === "running") {
          void lifecycle.stop("failure");
        }
      });
    },

    // Stops the core once; a second call waits for the first. A failure that
    // comes while a signal's stop is under way still makes the exit code 1.
    stop(reason: "signal" | "failure"): Promise<CoreExit> {
      if (reason === "failure") failed = true;
      if (stopping) return stopping;
      enter("stopping");
      log(`core: stopping (${reason})`);
      for (const [label, run] of steps?.stopNewWork ?? []) {
        try {
          run();
        } catch (error) {
          fail(label, error);
        }
      }
      stopStarting.abort();
      stopping = (async () => {
        await underWay;
        for (const [label, run] of steps?.stopping ?? []) {
          log(`core: stopping: ${label}`);
          try {
            await run(stopStarting.signal);
          } catch (error) {
            fail(label, error);
          }
        }
        enter("stopped");
        const exit: CoreExit = {
          code: failed ? 1 : 0,
          failedSteps: [...failedSteps],
        };
        log(`core: stopped (${exit.code})`);
        exited(exit);
        return exit;
      })();
      return stopping;
    },
  };
  return lifecycle;
}

export type CoreLifecycle = ReturnType<typeof createCoreLifecycle>;
