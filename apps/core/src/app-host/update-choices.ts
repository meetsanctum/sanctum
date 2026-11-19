import type { InstalledApp } from "./installed.js";
import type { AppUpdates } from "./updates.js";
import type { WaitingUpdates } from "./waiting.js";

type AllowOutcome =
  false | "unavailable" | "replaced" | "inPlace" | "waitsForRoom";

// Applying someone's choice of version while the app can be removed,
// replaced or sent back during the package read. Going back, allowing an
// update and retrying a wait for room take turns for an app.
export function createAppUpdateChoices(options: {
  installed: ReadonlyMap<string, InstalledApp>;
  updates: Pick<AppUpdates, "startGoingBack" | "swapTo" | "shownFor">;
  waiting: WaitingUpdates;
  // Clients hear of a wait that changed.
  announce: (entry: InstalledApp) => void;
  log: (message: string) => void;
}) {
  const { installed, updates, waiting, log } = options;
  const turns = new Map<string, Promise<unknown>>();

  function inTurn<T>(appId: string, work: () => Promise<T>): Promise<T> {
    const result = (turns.get(appId) ?? Promise.resolve()).then(work, work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    turns.set(appId, settled);
    void settled.then(() => {
      if (turns.get(appId) === settled) turns.delete(appId);
    });
    return result;
  }

  return {
    onGoBack: (entry: InstalledApp, copyId: string) =>
      inTurn(entry.app.id, () => goBack(entry, copyId)),

    onAllowUpdate: (
      entry: InstalledApp,
      id: string,
      alongside: () => void,
    ): Promise<AllowOutcome> =>
      inTurn(entry.app.id, () => allowUpdate(entry, id, alongside)),

    onRetryRoom: (entry: InstalledApp, signal?: AbortSignal) =>
      inTurn(entry.app.id, () => retryRoom(entry, signal)),
  };

  async function retryRoom(entry: InstalledApp, signal?: AbortSignal) {
    const appId = entry.app.id;
    const grantsRevision = entry.grantsRevision;
    const isCurrent = () =>
      installed.get(appId) === entry && !entry.supervision.isEnded;
    const canRetry = () =>
      !signal?.aborted &&
      !entry.off &&
      isCurrent() &&
      entry.grantsRevision === grantsRevision;
    if (!canRetry()) return;
    try {
      await waiting.retry(appId, {
        canRetry,
        start: (pkg) => {
          delete entry.waiting;
          updates.swapTo(entry, pkg);
        },
      });
    } catch (error) {
      log(`apps: ${appId}'s update wasn't tried again (${String(error)})`);
      return;
    }
    if (!isCurrent()) return;
    const now = waiting.of(appId);
    if (
      now?.id !== entry.waiting?.id ||
      now?.moreMemoryMb !== entry.waiting?.moreMemoryMb
    ) {
      entry.waiting = now;
      options.announce(entry);
    }
  }

  async function goBack(entry: InstalledApp, copyId: string) {
    // A newer version that waits goes with the choice to go back, in its
    // transaction, so neither is kept without the other.
    try {
      const appId = entry.app.id;
      if (
        !(await updates.startGoingBack(entry, copyId, () =>
          waiting.drop(appId),
        ))
      ) {
        return false;
      }
    } catch (error) {
      log(`apps: ${entry.app.id} can't go back (${String(error)})`);
      return false;
    }
    delete entry.waiting;
    return true;
  }

  async function allowUpdate(
    entry: InstalledApp,
    id: string,
    alongside: () => void,
  ): Promise<AllowOutcome> {
    const appId = entry.app.id;
    let allowed;
    try {
      allowed = await waiting.allow(appId, id, {
        canAllow: () =>
          installed.get(appId) === entry &&
          !entry.supervision.isEnded &&
          updates.shownFor(appId)?.stage !== "goingBack",
        alongside,
        isInPlace: (pkg) => pkg.apart.folder === entry.apartIn,
      });
    } catch (error) {
      // Its package couldn't be read, and asking again may work.
      log(`apps: ${appId} can't update (${String(error)})`);
      return "unavailable";
    }
    if (!allowed) {
      // It may wait anew, needing more than it showed.
      const now = waiting.of(appId);
      if (installed.get(appId) === entry && now?.id !== entry.waiting?.id) {
        entry.waiting = now;
        options.announce(entry);
      }
      return false;
    }
    if (allowed === "waitsForRoom") {
      entry.waiting = waiting.of(appId);
      options.announce(entry);
      return "waitsForRoom";
    }
    if (allowed.apart.folder === entry.apartIn) return "inPlace";
    updates.swapTo(entry, allowed);
    return "replaced";
  }
}
