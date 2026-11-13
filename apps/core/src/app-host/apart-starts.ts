import type { StopInfo } from "@meetsanctum/app-sdk";

import type { ApartPackage } from "./host.js";
import type { InstalledApp } from "./installed.js";
import type { Supervisor } from "./supervisor.js";
import type { AppUpdates } from "./updates.js";

// Starting an app apart, including replacing a failed update's package. Recovery
// finishes before its socket opens, and removal and shutdown can cancel a swap.
export function createApartStarts(options: {
  installed: Map<string, InstalledApp>;
  removals: Map<string, Promise<void>>;
  updates: AppUpdates;
  supervisor: Supervisor;
  install: (pkg: ApartPackage, checked: Set<string>) => void;
  stopApp: (
    entry: InstalledApp,
    info: { reason: StopInfo["reason"]; gone?: boolean },
  ) => Promise<void>;
  announce: (entry: InstalledApp) => void;
  log: (message: string) => void;
}) {
  const {
    installed,
    removals,
    updates,
    supervisor,
    install,
    stopApp,
    announce,
    log,
  } = options;
  let isClosed = false;
  const starting = new WeakMap<InstalledApp, Promise<void>>();
  const listening = new WeakMap<InstalledApp, Promise<void>>();
  const sockets = new Set<Promise<void>>();
  const replacements = new Map<
    string,
    { isCancelled: boolean; work: Promise<void> }
  >();
  const isCurrent = (entry: InstalledApp) =>
    !isClosed &&
    installed.get(entry.manifest.id) === entry &&
    !entry.supervision.isEnded;

  async function listen(entry: InstalledApp) {
    try {
      await updates.recover();
    } catch (error) {
      if (!isCurrent(entry)) return;
      log(`apps: ${entry.app.id} waits for update recovery (${String(error)})`);
      supervisor.waits(
        entry,
        "Waiting for its data to come back",
        () => void start(entry),
        updates.turnPauseMs,
      );
      return;
    }
    if (!isCurrent(entry)) return;
    try {
      let opened = listening.get(entry);
      if (!opened) {
        opened = entry.link.listen();
        listening.set(entry, opened);
        sockets.add(opened);
        const settled = () => void sockets.delete(opened!);
        void opened.then(settled, settled);
      }
      await opened;
      if (isCurrent(entry)) updates.arrive(entry);
    } catch (error) {
      log(`apps: ${entry.app.id} has no socket (${String(error)})`);
      supervisor.startFailed(entry);
    }
  }

  function start(entry: InstalledApp) {
    const pending = starting.get(entry);
    if (pending) return pending;
    const work = listen(entry).catch((error: unknown) => {
      log(`apps: ${entry.app.id} did not start (${String(error)})`);
    });
    starting.set(entry, work);
    const settled = () => void starting.delete(entry);
    void work.then(settled);
    return work;
  }

  // Safe to ask again: one that failed part way has taken the old entry out and left
  // its record here, and the next try picks up from there.
  async function replace(entry: InstalledApp, pkg: ApartPackage) {
    const appId = entry.manifest.id;
    const unfinished = replacements.get(appId);
    if (unfinished?.isCancelled) {
      replacements.delete(appId);
      return;
    }
    if (isClosed || (!unfinished && !isCurrent(entry))) return;
    installed.delete(appId);
    const ended = supervisor.end(entry);
    const replacement = unfinished ?? {
      isCancelled: false,
      work: Promise.resolve(),
    };
    const work = (async () => {
      await entry.lifecycle;
      await ended;
      await stopApp(entry, { reason: "restarting", gone: true });
      entry.storage.close();
      await entry.link.close();
      if (isClosed || replacement.isCancelled) return;
      install(pkg, new Set());
      const next = installed.get(appId)!;
      announce(next);
      void start(next);
    })();
    replacement.work = work;
    replacements.set(appId, replacement);
    removals.set(appId, work);
    try {
      await work;
      replacements.delete(appId);
    } finally {
      if (removals.get(appId) === work) removals.delete(appId);
    }
  }

  updates.use({
    launch: (entry) => void supervisor.launch(entry),
    waits: (entry, why, again) =>
      supervisor.waits(entry, why, again, updates.turnPauseMs),
    replace,
    isCurrent,
  });

  return {
    start,
    cancel(appId: string) {
      const replacement = replacements.get(appId);
      if (replacement) replacement.isCancelled = true;
    },
    async close() {
      isClosed = true;
      await Promise.allSettled([
        ...sockets,
        ...[...replacements.values()].map(({ work }) => work),
      ]);
    },
  };
}
