import type { InstalledApp } from "./installed.js";
import type { AppUpdates } from "./updates.js";
import type { WaitingUpdates } from "./waiting.js";

// Applying someone's choice of version while the app can be removed,
// replaced or sent back during the package read. Going back and allowing an
// update take turns for an app, so the second sees what the first did: one
// that replaced the app leaves nothing current for the other.
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
    ): Promise<false | "unavailable" | "replaced" | "inPlace"> =>
      inTurn(entry.app.id, () => allowUpdate(entry, id, alongside)),

    onRetryRoom: (entry: InstalledApp) =>
      inTurn(entry.app.id, () => retryRoom(entry)),
  };

  // An update that waited for room starts once there is some: the manager
  // holds that room until its container starts.
  async function retryRoom(entry: InstalledApp) {
    const appId = entry.app.id;
    if (installed.get(appId) !== entry || entry.supervision.isEnded) return;
    let pkg;
    try {
      pkg = await waiting.retry(appId);
    } catch (error) {
      log(`apps: ${appId}'s update wasn't tried again (${String(error)})`);
      return;
    }
    if (installed.get(appId) !== entry || entry.supervision.isEnded) return;
    if (!pkg) {
      // It may need more or less than it did.
      const now = waiting.of(appId);
      if (now?.moreMemoryMb !== entry.waiting?.moreMemoryMb) {
        entry.waiting = now;
        options.announce(entry);
      }
      return;
    }
    delete entry.waiting;
    updates.swapTo(entry, pkg);
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
  ): Promise<false | "unavailable" | "replaced" | "inPlace"> {
    const appId = entry.app.id;
    let allowed;
    try {
      allowed = await waiting.allow(appId, id, {
        canAllow: () =>
          installed.get(appId) === entry &&
          !entry.supervision.isEnded &&
          updates.shownFor(appId)?.stage !== "goingBack",
        alongside,
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
    if (allowed.apart.folder === entry.apartIn) return "inPlace";
    updates.swapTo(entry, allowed);
    return "replaced";
  }
}
