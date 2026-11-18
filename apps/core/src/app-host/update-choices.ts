import type { InstalledApp } from "./installed.js";
import type { AppUpdates } from "./updates.js";
import type { WaitingUpdates } from "./waiting.js";

// Applying someone's choice of version while the app can be removed,
// replaced or sent back during the package read.
export function createAppUpdateChoices(options: {
  installed: ReadonlyMap<string, InstalledApp>;
  updates: Pick<AppUpdates, "startGoingBack" | "swapTo" | "shownFor">;
  waiting: WaitingUpdates;
  // Clients hear of a wait that changed.
  announce: (entry: InstalledApp) => void;
  log: (message: string) => void;
}) {
  const { installed, updates, waiting, log } = options;

  return {
    async onGoBack(entry: InstalledApp, copyId: string) {
      try {
        if (!(await updates.startGoingBack(entry, copyId))) return false;
        waiting.forget(entry.app.id);
        delete entry.waiting;
        return true;
      } catch (error) {
        log(`apps: ${entry.app.id} can't go back (${String(error)})`);
        return false;
      }
    },

    async onAllowUpdate(
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
    },
  };
}
