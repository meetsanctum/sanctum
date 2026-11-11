import { randomUUID } from "node:crypto";

import { errorMessage } from "../docker.js";
import { OperationConflictError, type Operations } from "../operations.js";
import { resolveRelease, type Release } from "../release.js";
import type { UpdateContext } from "./context.js";
import { resumeCore, rollbackCore, updateCore } from "./core-update.js";
import { pullServiceImage } from "./images.js";
import { finish, isFinished, note, type UpdateJournal } from "./journal.js";
import { handOverManager, resumeManager } from "./manager-update.js";

export class UpdateConflictError extends Error {}

// Updates the host to a release: pull both images, update the core, then hand
// over to the updater for the manager. The core goes first so a failed core
// leaves the whole host on the previous release.
export function createUpdateService(
  context: UpdateContext & {
    config: Parameters<typeof resolveRelease>[0];
    operations: Operations;
    onCoreCommitted: (image: string) => Promise<void>;
    waitForReconcile?: () => Promise<void>;
  },
) {
  let running: Promise<void> | null = null;
  let isStarting = false;
  context.operations.heldBy(async () => {
    const journal = await context.journal.read();
    return journal && !isFinished(journal)
      ? { kind: "core-update", version: journal.version }
      : null;
  });

  async function run(journal: UpdateJournal) {
    try {
      await context.waitForReconcile?.();
      for (const service of ["core", "manager"] as const) {
        await pullServiceImage(context.docker, service, journal[service]);
      }
      await note(
        context.journal,
        journal,
        `Pulled core ${journal.core.version} and manager ${journal.manager.version}`,
        context.log,
      );
    } catch (error) {
      journal.error = errorMessage(error);
      await finish(
        context.journal,
        journal,
        "failed",
        `Nothing changed: ${journal.error}`,
        context.log,
      );
      return;
    }

    journal.phase = "core";
    let committed: boolean;
    try {
      committed = await updateCore(context, journal);
    } catch (error) {
      // Once the commit starts, clients may have written new data. Leave
      // cleanup journalled for recovery; never restore the old snapshot.
      if (
        [
          "committing",
          "updated",
          "rolling-back",
          "restored",
          "rolled-back",
        ].includes(journal.core.status)
      ) {
        throw error;
      }
      if (
        journal.core.status === "pending" ||
        journal.core.status === "skipped"
      ) {
        journal.error = errorMessage(error);
        await finish(
          context.journal,
          journal,
          "failed",
          journal.error,
          context.log,
        );
        return;
      }
      await rollbackCore(context, journal, errorMessage(error));
      committed = false;
    }
    await afterCore(journal, committed);
  }

  async function afterCore(journal: UpdateJournal, committed: boolean) {
    if (!committed) {
      await finish(
        context.journal,
        journal,
        "rolled-back",
        "The update was rolled back",
        context.log,
      );
      return;
    }
    if (journal.core.status === "updated") {
      await context.onCoreCommitted(journal.core.imageId!);
    }

    journal.phase = "manager";
    try {
      if (await handOverManager(context, journal, context.config.version)) {
        // The updater finishes the journal.
        return;
      }
    } catch (error) {
      journal.error = errorMessage(error);
      await finish(
        context.journal,
        journal,
        "failed",
        `The manager was not updated: ${journal.error}`,
        context.log,
      );
      return;
    }
    const unchanged = journal.core.status === "skipped";
    await finish(
      context.journal,
      journal,
      unchanged ? "unchanged" : "updated",
      unchanged ? "Already up to date" : `Updated to ${journal.version}`,
      context.log,
    );
  }

  async function busy() {
    return (
      isStarting ||
      running !== null ||
      !isFinished(await context.journal.read())
    );
  }

  return {
    busy,
    channel: context.config.channel,
    status: () => context.journal.read(),

    // Validates the request and starts the update in the background; the
    // journal reports its progress.
    async start(version?: string) {
      const release: Release = resolveRelease(context.config, version);
      if (isStarting || running !== null) {
        throw new UpdateConflictError("An update is already running");
      }
      // Reserve before the first await, so the reconcile loop stands aside at
      // once and concurrent requests cannot both start.
      isStarting = true;
      try {
        return await context.operations.claim(
          { kind: "core-update", version: release.version },
          async () => {
            const journal: UpdateJournal = {
              id: randomUUID().slice(0, 8),
              version: release.version,
              startedAt: new Date().toISOString(),
              phase: "pulling",
              core: { status: "pending", image: release.images.core },
              manager: { status: "pending", image: release.images.manager },
              log: [],
            };
            await note(
              context.journal,
              journal,
              `Updating to ${release.version}`,
              context.log,
            );
            running = run(journal)
              .catch((error: unknown) =>
                context.log(
                  `update ${journal.id} failed: ${errorMessage(error)}`,
                ),
              )
              .finally(() => {
                running = null;
              });
            return journal;
          },
        );
      } catch (error) {
        throw error instanceof OperationConflictError
          ? new UpdateConflictError(error.message)
          : error;
      } finally {
        isStarting = false;
      }
    },

    // Called once at start: finishes or undoes an update a crash or reboot
    // interrupted, so the host never stays half updated.
    async resume() {
      const journal = await context.journal.read();
      if (!journal || isFinished(journal)) {
        return;
      }
      if (journal.phase === "manager") {
        // A running updater owns the journal; only write it if it is gone.
        await resumeManager(context, journal);
        return;
      }
      await note(context.journal, journal, "Resuming the update", context.log);
      if (journal.phase === "pulling") {
        await finish(
          context.journal,
          journal,
          "failed",
          "Interrupted before anything changed",
          context.log,
        );
        return;
      }
      await afterCore(journal, await resumeCore(context, journal));
    },

    async wait() {
      await running;
    },
  };
}

export type UpdateService = ReturnType<typeof createUpdateService>;
