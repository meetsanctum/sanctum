import { errorMessage } from "./docker.js";

// Ported from v1's manager: one reconcile at a time, run at start and then on
// an interval, so the host converges after crashes, reboots and hand edits.

export type Reconciler = {
  reconcile: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => void;
  wait: () => Promise<void>;
};

export function createReconciler(options: {
  intervalMs?: number;
  log: (message: string) => void;
  // Skips a run, for example while an update owns the containers.
  paused?: () => boolean | Promise<boolean>;
  run: () => Promise<void>;
}): Reconciler {
  let inflight: Promise<void> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  async function reconcileNow() {
    try {
      if (await options.paused?.()) {
        return;
      }
      await options.run();
    } catch (error) {
      options.log(`Reconcile failed: ${errorMessage(error)}`);
    }
  }

  function reconcile() {
    inflight ??= reconcileNow().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    reconcile,
    async wait() {
      await inflight;
    },
    async start() {
      await reconcile();
      if (options.intervalMs === 0 || interval) {
        return;
      }
      interval = setInterval(
        () => void reconcile(),
        options.intervalMs ?? 30_000,
      );
      interval.unref?.();
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
