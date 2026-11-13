import { access, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { Log } from "../docker-resources.js";
import { syncPath } from "../durable.js";
import type { Operations } from "../operations.js";
import { readJson, writeJson } from "../state.js";
import type { AppContainers } from "./containers.js";
import { defaultImageMb, type AppImages } from "./images.js";
import type { Maintenance } from "./maintenance.js";
import { AppRefusal } from "./refusal.js";

// The manager's journal of an app's update. The core starts updates and decides how
// they end; this is what it can't do itself, stopping the app and copying its database,
// or putting that copy back, each step written down before it's taken. While an entry
// is here the update holds the slot it shares with the host's other operations
// (operations.ts). Whether the new version committed is the core's to say, from the one
// row it writes, so a missing entry here is simply caught up. Going back is an update
// in the other direction: it copies the version it's leaving, so that a failed older
// start can return to it, then puts the kept copy in place, and that copy goes for good
// once it commits. An app's first move takes its file from the core's data instead of
// copying anything, and has nothing to undo, as that file stays as it was, so it holds
// the slot only while it takes that file in.

export type AppVersionRef = { version: string; folder: string };

type UpdateRequest = Pick<
  AppUpdateEntry,
  "id" | "from" | "to" | "file" | "restores" | "moves" | "dataMb"
>;

export type AppUpdateEntry = {
  id: string;
  // No folder on an app's first move, from a core that ran it in its own process.
  from: { version: string; folder?: string };
  to: AppVersionRef;
  // The database, as named in the app's data.
  file: string;
  // Going back: the update whose kept copy goes in place.
  restores?: string;
  // An app's first move: its file in the core's apps folder, which it takes in, and
  // the size of the image it makes for that.
  moves?: string;
  dataMb?: number;
  // copying: it's stopping and its database is being copied.
  // placing: going back, that copy is whole, and the kept one is going in place.
  // ready: the copy is whole and synced, and the new version may run.
  // undoing: the copy is going back, and nothing runs until it's back.
  status: "copying" | "placing" | "ready" | "undoing";
  // When it reached that step, which holds the slot for so long at most.
  stepAt?: string;
  // Whether there's a copy to put back: a first start may have no database yet.
  copied: boolean;
  startedAt: string;
};

// What the last update kept for Go back: the app's data before it, and the version
// that goes with that data.
export type KeptCopy = { id: string; from: AppVersionRef; at: string };

type UpdatesState = {
  updates: Record<string, AppUpdateEntry>;
  // The folder each app last ran from, which staging keeps however many versions
  // arrive meanwhile, since an update may have to go back to it.
  running: Record<string, string>;
  kept: Record<string, KeptCopy>;
};

// How long one step keeps the host's other operations waiting. Past it the update is
// set aside: its journal and its copy stay, so a core that starts later can settle it,
// and the core update that would fix it can still run.
const stepLimitMs = 10 * 60_000;

const copiesFolder = "app-copies";
const copyName = (id: string) => `${id}.db`;

export function createAppUpdates(options: {
  dataDir: string;
  operations: Operations;
  apps: Pick<AppContainers, "stop" | "onItsImage">;
  images: Pick<AppImages, "has" | "ensure">;
  maintenance: Pick<Maintenance, "run">;
  hasPackage: (app: string, folder: string) => Promise<boolean>;
  log: Log;
}) {
  const { dataDir, operations, apps, images, maintenance, log } = options;
  const path = join(dataDir, "app-updates.json");
  let state: UpdatesState = { updates: {}, running: {}, kept: {} };
  // One change at a time, so a save can't lose another's.
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>) => {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  };

  async function save(change: (draft: UpdatesState) => void) {
    const next = structuredClone(state);
    change(next);
    await writeJson(path, next, { mode: 0o600 });
    state = next;
  }

  // On its image, as the app's user can't reach the copies and the copies are kept
  // out of what the app can read.
  const onImage = (app: string, work: (volume: string) => Promise<unknown>) =>
    apps.onItsImage(app, async (releaseVolume) => {
      if (!(await images.has(app))) return false;
      await work(await images.ensure(app, defaultImageMb, releaseVolume));
      return true;
    });

  async function copy(app: string, entry: AppUpdateEntry) {
    try {
      return await onImage(app, (volume) =>
        maintenance.run(app, volume, {
          operation: "copy",
          file: entry.file,
          name: copyName(entry.id),
        }),
      );
    } catch (error) {
      // An image with no database yet has nothing to lose.
      if (error instanceof AppRefusal && error.status === 404) return false;
      throw error;
    }
  }

  // Its image may not exist yet, as it hasn't run apart before.
  async function adopt(app: string, entry: AppUpdateEntry) {
    try {
      await apps.onItsImage(app, async (releaseVolume) => {
        const volume = await images.ensure(
          app,
          entry.dataMb ?? defaultImageMb,
          releaseVolume,
        );
        await maintenance.run(app, volume, {
          operation: "adopt",
          file: entry.file,
          name: entry.moves!,
        });
      });
    } catch (error) {
      // An app with no database yet has nothing to bring.
      if (!(error instanceof AppRefusal && error.status === 404)) throw error;
    }
  }

  async function putBack(app: string, file: string, id: string) {
    const restored = await onImage(app, (volume) =>
      maintenance.run(app, volume, {
        operation: "restore",
        file,
        name: copyName(id),
      }),
    );
    if (!restored) {
      throw new AppRefusal(`${app} has no data image to restore`, 404);
    }
  }

  // Keeps the one that was just made, which a later Go back may want.
  async function pruneCopies(app: string, keep?: string) {
    const folder = join(dataDir, copiesFolder, app);
    const names = await readdir(folder).catch(() => [] as string[]);
    for (const name of names) {
      if (name.endsWith(".db") && name !== keep) {
        await unlink(join(folder, name)).catch(() => undefined);
      }
    }
    if (names.length > 0) await syncPath(folder).catch(() => undefined);
  }

  // Only once the journal no longer needs it: put back again after a crash, an undo
  // that found its copy gone could never finish. A crash between the two leaves it
  // for the next commit to prune. The copy before it stays, for a later Go back.
  async function removeCopy(app: string, id: string) {
    const folder = join(dataDir, copiesFolder, app);
    await unlink(join(folder, copyName(id))).catch(() => undefined);
    await syncPath(folder).catch(() => undefined);
  }

  async function copyIt(
    app: string,
    request: UpdateRequest,
    startedAt = new Date().toISOString(),
  ) {
    const entry: AppUpdateEntry = {
      ...request,
      status: "copying",
      copied: false,
      startedAt,
      stepAt: new Date().toISOString(),
    };
    await save((draft) => {
      draft.updates[app] = entry;
    });
    log(`Updating ${app} from ${entry.from.version}`);
    try {
      await apps.stop(app);
      if (entry.moves) await adopt(app, entry);
      const copied = entry.moves ? false : await copy(app, entry);
      const next: AppUpdateEntry = {
        ...entry,
        status: entry.restores ? "placing" : "ready",
        copied,
        stepAt: new Date().toISOString(),
      };
      await save((draft) => {
        draft.updates[app] = next;
      });
      return next;
    } catch (error) {
      // Nothing has changed, so the slot frees and the core tries later.
      await save((draft) => {
        delete draft.updates[app];
      });
      await removeCopy(app, entry.id);
      throw error;
    }
  }

  options.operations.heldBy((continuing) => {
    for (const [app, entry] of Object.entries(state.updates)) {
      if (
        continuing?.kind === "app-update" &&
        continuing.app === app &&
        continuing.to === entry.to.version
      )
        continue;
      // A first move that has taken in its file has nothing left to undo: the
      // original stays as it was, and anything that comes can start it afresh.
      // So its start, however long it waits or however often it fails, holds up
      // nobody, such as the other apps moving with it.
      if (entry.moves && entry.status === "ready") continue;
      const since = Date.parse(entry.stepAt ?? entry.startedAt);
      if (Date.now() - since < stepLimitMs) {
        return { kind: "app-update", app, to: entry.to.version };
      }
    }
    return null;
  });

  return {
    /** Finds what a manager before this one was doing. */
    async load() {
      const saved = await readJson<Partial<UpdatesState>>(path);
      state = {
        updates: saved?.updates ?? {},
        running: saved?.running ?? {},
        kept: saved?.kept ?? {},
      };
    },

    /** What's under way, for the core to catch up. */
    list: () => state.updates,

    /** The folders nothing may prune, whichever versions have been staged since. */
    foldersInUse() {
      const folders: { app: string; folder: string }[] = [];
      for (const [app, folder] of Object.entries(state.running)) {
        folders.push({ app, folder });
      }
      for (const [app, { from, to }] of Object.entries(state.updates)) {
        if (from.folder) folders.push({ app, folder: from.folder });
        folders.push({ app, folder: to.folder });
      }
      for (const [app, { from }] of Object.entries(state.kept)) {
        folders.push({ app, folder: from.folder });
      }
      return folders;
    },

    /** What Go back would return to, while its copy and package are still there. */
    async kept(app: string) {
      const kept = state.kept[app];
      if (!kept) return null;
      const copy = join(dataDir, copiesFolder, app, copyName(kept.id));
      const hasCopy = await access(copy).then(
        () => true,
        () => false,
      );
      return hasCopy && (await options.hasPackage(app, kept.from.folder))
        ? kept
        : null;
    },

    /**
     * Takes the slot, stops the app and copies its database, which can take a
     * while, and if it's going back, puts the kept copy in place. Asked again for the
     * same update it carries on from where it was, as after a crash, and refuses an
     * update while another is under way.
     */
    begin(app: string, request: UpdateRequest) {
      const current = state.updates[app];
      if (current && current.id !== request.id) {
        throw new AppRefusal(`${app} is still settling an earlier update`, 409);
      }
      if (current?.status === "ready") return Promise.resolve(current);
      if (current?.status === "undoing") {
        throw new AppRefusal(`${app}'s update is being undone`, 409);
      }
      if (!current && request.restores) {
        if (state.kept[app]?.id !== request.restores) {
          throw new AppRefusal(`${app} has no such copy to go back to`, 404);
        }
      }
      return operations.claim(
        { kind: "app-update", app, to: request.to.version },
        () =>
          inTurn(async () => {
            const copied =
              current?.status === "placing"
                ? current
                : await copyIt(app, request, current?.startedAt);
            if (copied.status === "ready") return copied;
            // Its data may have changed from here, so a failure stays in the journal
            // for the core to undo.
            await apps.stop(app);
            await putBack(app, copied.file, copied.restores!);
            const ready = {
              ...copied,
              status: "ready" as const,
              stepAt: new Date().toISOString(),
            };
            await save((draft) => {
              draft.updates[app] = ready;
            });
            return ready;
          }),
        { isContinuing: current !== undefined },
      );
    },

    /** The core wrote its row, so the update is over. */
    commit(app: string, id: string) {
      return inTurn(async () => {
        const current = state.updates[app];
        if (current?.id !== id) return;
        // Going back leaves nothing to go back to: the copy it came from has done its
        // job, and the version it left is what the home's next update replaces.
        const before = current.from.folder;
        const keeps = current.copied && !current.restores && before;
        await save((draft) => {
          delete draft.updates[app];
          draft.running[app] = current.to.folder;
          if (keeps) {
            draft.kept[app] = {
              id,
              from: { version: current.from.version, folder: before },
              at: current.startedAt,
            };
          } else {
            delete draft.kept[app];
          }
        });
        await pruneCopies(app, keeps ? copyName(id) : undefined);
        log(`${app} is on ${current.to.version}`);
      });
    },

    /**
     * Stops whatever runs and puts the copy back, then frees the slot. Once that's
     * written it's never done again, whatever the core asks, since the old version
     * may have started by then.
     */
    undo(app: string, id: string) {
      return inTurn(async () => {
        const current = state.updates[app];
        if (current?.id !== id) return;
        return operations.claim(
          { kind: "app-update", app, to: current.to.version },
          async () => {
            await save((draft) => {
              draft.updates[app]!.status = "undoing";
              if (current.status !== "undoing") {
                draft.updates[app]!.stepAt = new Date().toISOString();
              }
            });
            log(`Undoing ${app}'s update to ${current.to.version}`);
            await apps.stop(app);
            if (current.copied) await putBack(app, current.file, id);
            await save((draft) => {
              delete draft.updates[app];
              if (current.from.folder) {
                draft.running[app] = current.from.folder;
              } else {
                delete draft.running[app];
              }
            });
            await removeCopy(app, id);
            log(`${app}'s data is back as it was on ${current.from.version}`);
          },
          { isContinuing: true },
        );
      });
    },
  };
}

export type AppUpdates = ReturnType<typeof createAppUpdates>;
