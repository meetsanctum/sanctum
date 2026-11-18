import { servesAppApi } from "./fit.js";
import { speaksThisCore, type ApartPackage } from "./loader.js";
import type { AppUpdateRow } from "./updates.js";

// A kept version must fit both the runner's protocol and the app API.
export const canRunPackage = (pkg: ApartPackage) =>
  speaksThisCore(pkg) && servesAppApi(pkg.apart.manifest);

// Selecting the build for an update or its recovery, before the host
// installs anything from it.
export function createUpdatePackages(options: {
  rowOf: (appId: string) => AppUpdateRow | undefined;
  forget: (appId: string) => void;
  undo: (appId: string) => void;
  loadPackage: (appId: string, folder: string) => Promise<ApartPackage>;
  now: () => Date;
  log: (message: string) => void;
}) {
  const { rowOf, forget, loadPackage, now, log } = options;

  return {
    /**
     * Whether the change of version recorded for it decides this build: one
     * under way, or the build it went back from or that failed, which it
     * stays away from until its time to try again, so what it needs can't
     * undo someone's Go back.
     */
    isUnderWay(pkg: ApartPackage): boolean {
      const row = rowOf(pkg.apart.manifest.id);
      const { folder } = pkg.apart;
      if (!row) return false;
      if (row.status === "undone") {
        return (
          row.toFolder === folder && !(row.retryAt && row.retryAt <= now())
        );
      }
      return row.fromFolder === folder || row.toFolder === folder;
    },

    /**
     * Which version to install as the core starts: the one its image brings, unless
     * an update of it failed or never reached its commit, which brings the old one
     * back. This writes only to the core's own data, so a core on trial may run it.
     */
    async packageFor(pkg: ApartPackage): Promise<ApartPackage> {
      const appId = pkg.apart.manifest.id;
      const row = rowOf(appId);
      if (!row) return pkg;
      const folder = pkg.apart.folder;
      // A first move has no staged folder for the version it leaves.
      if (row.fromFolder === "") {
        const isTheSame = row.toFolder === folder;
        // It hadn't started, so it carries on.
        if (row.status === "waiting" && isTheSame) return pkg;
        // Another version, its time to try again, or one a core that ran it in its
        // own process went back from: a move from the start.
        const isTimeToRetry = row.retryAt !== null && row.retryAt <= now();
        if (!isTheSame || isTimeToRetry || row.status === "undone") {
          forget(appId);
        }
        // With nowhere else to carry on, it goes on from the copy it took in.
        return pkg;
      }
      // A version whose protocol or app API doesn't fit can't run, so the one the
      // core brings starts instead. The manager puts back the copy of an
      // update no row speaks for, and the update begins again from there.
      const useIfRunnable = async (other: string, then?: () => void) => {
        const kept = await loadPackage(appId, other);
        if (canRunPackage(kept)) {
          then?.();
          return kept;
        }
        log(
          `apps: ${appId} ${kept.apart.manifest.version} can't run on this core, so it starts on ${pkg.apart.manifest.version}`,
        );
        forget(appId);
        return pkg;
      };
      if (row.status === "waiting") {
        // Someone asked to go back, and the core still brings what they left.
        if (row.restores && row.fromFolder === folder) {
          return useIfRunnable(row.toFolder);
        }
        // Another version arrived while it waited. What it stopped is still there.
        if (row.toFolder !== folder) forget(appId);
        return pkg;
      }
      if (
        row.status === "undone" &&
        (row.toFolder !== folder || (row.retryAt && row.retryAt <= now()))
      ) {
        forget(appId);
        return pkg;
      }
      // Its data is back, so another version needn't wait for the old one's start,
      // which may never finish, and which would hold back the version that fixes it.
      // The old package itself must still finish rebuilding what it owns.
      if (
        row.status === "restored" &&
        row.toFolder !== folder &&
        row.fromFolder !== folder
      ) {
        forget(appId);
        return pkg;
      }
      // The power went after it started and before its commit.
      return useIfRunnable(row.fromFolder, () => {
        if (row.status === "starting") options.undo(appId);
      });
    },
  };
}
