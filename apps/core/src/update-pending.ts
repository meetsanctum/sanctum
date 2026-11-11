import { existsSync } from "node:fs";
import { join } from "node:path";

// The manager writes this file into the core's data volume before it starts a
// new core and removes it to commit the update (apps/manager/src/update/
// core-update.ts). Until then the core answers only its health check, so no
// client can change anything a rollback would lose.
export const updatePendingFile = "update-pending";

export function watchUpdatePending(dataDir: string, intervalMs = 1_000) {
  const path = join(dataDir, updatePendingFile);
  let pending = existsSync(path);
  const committed: Array<() => void> = [];
  const timer = pending
    ? setInterval(() => {
        if (!existsSync(path)) {
          pending = false;
          clearInterval(timer);
          for (const run of committed.splice(0)) run();
        }
      }, intervalMs)
    : undefined;
  timer?.unref();

  return {
    isPending: () => pending,
    /**
     * Runs this once the update has committed, or now if nothing is pending. A
     * rollback never gets here: it ends this core and starts the one before.
     */
    whenCommitted(run: () => void) {
      if (pending) committed.push(run);
      else run();
    },
    close: () => clearInterval(timer),
  };
}
