import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  coreContainerName,
  coreRole,
  createCoreContainer,
  previousCoreContainerName,
} from "../core-container.js";
import { assertManaged } from "../docker-resources.js";
import { errorMessage, inspectContainer, inspectImage } from "../docker.js";
import { imageVersion, pruneImages } from "./images.js";
import { pruneSnapshots, restore, snapshot, snapshotName } from "./backup.js";
import type { UpdateContext } from "./context.js";
import { waitForHealth, type HealthBody } from "./health.js";
import { note, type UpdateJournal } from "./journal.js";

// While this file is in the core's data volume, the core answers only its
// health check (apps/core/src/update-pending.ts). An update creates it before
// the new core starts and removes it to commit, so no client can change
// anything a rollback would then lose.
export const updatePendingFile = "update-pending";

const backupPrefix = "core-";
const keptBackups = 3;

function backupsDir(context: UpdateContext) {
  return join(context.dataDir, "backups");
}

async function step(
  context: UpdateContext,
  journal: UpdateJournal,
  status: UpdateJournal["core"]["status"],
  message: string,
) {
  journal.core.status = status;
  await note(context.journal, journal, message, context.log);
}

function healthOf(
  context: UpdateContext,
  accept: (body: HealthBody) => boolean,
) {
  return waitForHealth({
    accept,
    containerName: coreContainerName,
    docker: context.docker,
    fetch: context.fetch ?? context.coreFetch,
    timing: context.timing,
    url: `${context.coreUrl}/api/health`,
  });
}

// Updates the core: stop it, snapshot its data, start the new image held,
// check its health and commit, or roll back. Returns whether the host now runs
// the new core.
export async function updateCore(
  context: UpdateContext,
  journal: UpdateJournal,
): Promise<boolean> {
  const { docker } = context;
  const target = journal.core;
  const current = await inspectContainer(docker, coreContainerName);
  for (const container of [
    current,
    await inspectContainer(docker, previousCoreContainerName),
  ]) {
    if (container)
      assertManaged(
        { labels: container.Config.Labels, name: container.Name },
        coreRole,
      );
  }
  if (current && current.Image === target.imageId) {
    await step(context, journal, "skipped", "The core is already up to date");
    return true;
  }

  if (current) {
    target.previousContainerId = current.Id;
    target.fromImageId = current.Image;
    target.fromVersion = imageVersion(
      await inspectImage(docker, current.Image),
    );
  }
  await step(context, journal, "stopping", "Stopping the core");
  if (current?.State.Running) {
    await docker.getContainer(current.Id).stop({ t: 30 });
  }

  await step(context, journal, "backing-up", "Backing up the core's data");
  target.backup = await snapshot(
    context.coreDataDir,
    backupsDir(context),
    snapshotName(backupPrefix, target.fromVersion),
  );

  await step(context, journal, "swapping", `Starting core ${target.version}`);
  await writeFile(join(context.coreDataDir, updatePendingFile), journal.id);
  if (current) {
    const stale = await inspectContainer(docker, previousCoreContainerName);
    if (stale) {
      await docker.getContainer(stale.Id).remove({ force: true });
    }
    await docker.getContainer(current.Id).rename({
      name: previousCoreContainerName,
    });
  }
  await createCoreContainer(docker, target.imageId!);
  await docker.getContainer(coreContainerName).start();

  await step(context, journal, "checking", "Checking the new core's health");
  try {
    await healthOf(
      context,
      (body) =>
        body.status === "ok" &&
        body.version === target.version &&
        body.updatePending === true,
    );
  } catch (error) {
    await rollbackCore(context, journal, errorMessage(error));
    return false;
  }

  await commitCore(context, journal);
  return true;
}

// Lets the new core serve clients and drops what a rollback would have used.
// From here the update can only go forward.
export async function commitCore(
  context: UpdateContext,
  journal: UpdateJournal,
) {
  const { docker } = context;
  await step(context, journal, "committing", "Committing the new core");
  await rm(join(context.coreDataDir, updatePendingFile), { force: true });
  try {
    await healthOf(
      context,
      (body) => body.status === "ok" && body.updatePending === false,
    );
  } catch (error) {
    context.log(
      `update ${journal.id}: the core did not confirm the commit: ${errorMessage(error)}`,
    );
  }

  const previous = await inspectContainer(docker, previousCoreContainerName);
  if (previous) {
    if (previous.Id !== journal.core.previousContainerId)
      throw new Error("The previous core was replaced");
    await docker.getContainer(previous.Id).remove({ force: true });
  }
  await pruneSnapshots(backupsDir(context), backupPrefix, keptBackups);
  await pruneImages(docker, "core", [journal.core.fromImageId]);
  await step(context, journal, "updated", `Core ${journal.core.version} is up`);
}

// Puts the previous core and its data back. Every step checks what is there
// first, so a rollback interrupted by a crash or reboot can simply run again.
export async function rollbackCore(
  context: UpdateContext,
  journal: UpdateJournal,
  reason: string,
) {
  const { docker } = context;
  const target = journal.core;
  journal.error = reason;
  if (target.status !== "restored") {
    await step(
      context,
      journal,
      "rolling-back",
      `Rolling back the core: ${reason}`,
    );

    const current = await inspectContainer(docker, coreContainerName);
    if (current && current.Id !== target.previousContainerId) {
      assertManaged(
        { labels: current.Config.Labels, name: current.Name },
        coreRole,
      );
      await docker.getContainer(current.Id).remove({ force: true });
    } else if (current?.State.Running) {
      await docker.getContainer(current.Id).stop({ t: 30 });
    }
    if (target.backup) {
      await restore(target.backup, context.coreDataDir);
    }
    // Persist before starting the old core: recovery must not overwrite writes
    // it accepts after the restore has completed.
    await step(context, journal, "restored", "The core's data is restored");
  }
  await rm(join(context.coreDataDir, updatePendingFile), { force: true });

  const previous = await inspectContainer(docker, previousCoreContainerName);
  if (previous) {
    if (previous.Id !== target.previousContainerId)
      throw new Error("The previous core was replaced");
    await docker.getContainer(previous.Id).rename({ name: coreContainerName });
  }
  const restored = await inspectContainer(docker, coreContainerName);
  if (restored) {
    assertManaged(
      { labels: restored.Config.Labels, name: restored.Name },
      coreRole,
    );
    if (!restored.State.Running) {
      await docker.getContainer(restored.Id).start();
    }
    try {
      await healthOf(
        context,
        (body) => body.status === "ok" && body.updatePending !== true,
      );
    } catch (error) {
      context.log(
        `update ${journal.id}: the previous core is not healthy either: ${errorMessage(error)}`,
      );
    }
  }
  await step(
    context,
    journal,
    "rolled-back",
    target.fromVersion
      ? `Core ${target.fromVersion} is back`
      : "The previous core is back",
  );
}

// Finishes a core update a crash or reboot interrupted. Until the commit
// began, nobody knows whether the new core was healthy, so it rolls back.
export async function resumeCore(
  context: UpdateContext,
  journal: UpdateJournal,
) {
  switch (journal.core.status) {
    case "committing":
      await commitCore(context, journal);
      return true;
    case "stopping":
    case "backing-up":
    case "swapping":
    case "checking":
    case "rolling-back":
    case "restored":
      await rollbackCore(
        context,
        journal,
        journal.error ?? "The update was interrupted",
      );
      return false;
    default:
      return (
        journal.core.status === "skipped" || journal.core.status === "updated"
      );
  }
}
