import { assertManaged, managedLabels } from "../docker-resources.js";
import {
  errorMessage,
  inspectContainer,
  inspectImage,
  type ContainerInfo,
} from "../docker.js";
import { socketFetch } from "../socket.js";
import { restartPolicy, stacked } from "../stack.js";
import { cloneContainerOptions } from "./clone.js";
import type { UpdateContext } from "./context.js";
import { waitForHealth } from "./health.js";
import { pruneImages } from "./images.js";
import { finish, note, type UpdateJournal } from "./journal.js";

// The manager cannot replace its own container while running in it, so it
// hands over to a short-lived updater container started from the new image.
// The updater swaps the manager, checks the new one's health and commits or
// rolls back. Running the new image's code means a fix to this logic ships
// with the update that needs it.

// Compose names the manager's container (deploy/compose.yml).
export const managerContainerName = stacked("sanctum-manager");
export const previousManagerContainerName = stacked("sanctum-manager-previous");
export const updaterContainerName = stacked("sanctum-manager-updater");
export const updaterRole = "manager-updater";
const maxUpdaterAttempts = 3;

function assertManager(container: ContainerInfo) {
  const labels = container.Config.Labels;
  if (
    labels?.["com.docker.compose.project"] !== stacked("sanctum") ||
    labels["com.docker.compose.service"] !== "manager"
  ) {
    throw new Error(`Refusing to manage unlabelled ${container.Name}`);
  }
}

async function step(
  context: UpdateContext,
  journal: UpdateJournal,
  status: UpdateJournal["manager"]["status"],
  message: string,
) {
  journal.manager.status = status;
  await note(context.journal, journal, message, context.log);
}

// Starts the updater with the manager's own mounts and network, so it reaches
// Docker, the journal and the manager's health check the same way.
async function startUpdater(context: UpdateContext, journal: UpdateJournal) {
  const { docker } = context;
  const manager = await inspectContainer(docker, managerContainerName);
  if (!manager) {
    throw new Error(`No ${managerContainerName} container to update`);
  }
  assertManager(manager);
  const stale = await inspectContainer(docker, updaterContainerName);
  if (stale?.State.Running) {
    throw new Error(`${updaterContainerName} is already running`);
  }
  if (stale) {
    assertManaged(
      { labels: stale.Config.Labels, name: stale.Name },
      updaterRole,
    );
    await docker.getContainer(stale.Id).remove({ force: true });
  }

  const image = journal.manager.imageId!;
  const hostConfig = manager.HostConfig as Record<string, unknown>;
  const { Env } = cloneContainerOptions(
    manager,
    await inspectImage(docker, manager.Image),
    image,
    updaterContainerName,
  );
  await docker.createContainer({
    name: updaterContainerName,
    Image: image,
    Cmd: ["node", "dist/updater.js"],
    Env,
    Labels: managedLabels(updaterRole),
    HostConfig: {
      Binds: hostConfig.Binds,
      Mounts: hostConfig.Mounts,
      NetworkMode: manager.HostConfig.NetworkMode,
      // On a host, recover a reboot during a swap. A development stack stays
      // stopped with the rest of its containers.
      RestartPolicy: restartPolicy,
      LogConfig: hostConfig.LogConfig,
    },
  });
  await docker.getContainer(updaterContainerName).start();
}

// Runs in the old manager: records what is being replaced and hands over.
// Returns false when the manager is already up to date.
export async function handOverManager(
  context: UpdateContext,
  journal: UpdateJournal,
  ownVersion: string,
) {
  const manager = await inspectContainer(context.docker, managerContainerName);
  if (manager) assertManager(manager);
  const previous = await inspectContainer(
    context.docker,
    previousManagerContainerName,
  );
  if (previous) assertManager(previous);
  if (manager?.Image === journal.manager.imageId) {
    await step(
      context,
      journal,
      "skipped",
      "The manager is already up to date",
    );
    return false;
  }
  journal.manager.previousContainerId = manager?.Id;
  journal.manager.fromImageId = manager?.Image;
  journal.manager.fromVersion = ownVersion;
  journal.manager.attempts = 1;
  await step(
    context,
    journal,
    "pending",
    `Handing over to the updater for manager ${journal.manager.version}`,
  );
  await startUpdater(context, journal);
  return true;
}

function managerHealth(context: UpdateContext, version: string | undefined) {
  return waitForHealth({
    accept: (body) => body.status === "ok" && body.version === version,
    containerName: managerContainerName,
    docker: context.docker,
    fetch: context.fetch ?? socketFetch(context.managerSocket),
    timing: context.timing,
    url: "http://manager/api/health",
  });
}

async function swap(context: UpdateContext, journal: UpdateJournal) {
  const { docker } = context;
  const target = journal.manager;
  await step(
    context,
    journal,
    "swapping",
    `Starting manager ${target.version}`,
  );

  const current = await inspectContainer(docker, managerContainerName);
  if (current && current.Id === target.previousContainerId) {
    assertManager(current);
    if (current.State.Running)
      await docker.getContainer(current.Id).stop({ t: 15 });
    const stale = await inspectContainer(docker, previousManagerContainerName);
    if (stale) {
      assertManager(stale);
      await docker.getContainer(stale.Id).remove({ force: true });
    }
    await docker.getContainer(current.Id).rename({
      name: previousManagerContainerName,
    });
  }

  const previous = await inspectContainer(docker, previousManagerContainerName);
  if (!previous || previous.Id !== target.previousContainerId) {
    throw new Error("The manager being replaced is gone");
  }
  if (!(await inspectContainer(docker, managerContainerName))) {
    await docker.createContainer(
      cloneContainerOptions(
        previous,
        await inspectImage(docker, previous.Image),
        target.imageId!,
        managerContainerName,
      ),
    );
  }
  const next = (await inspectContainer(
    docker,
    managerContainerName,
  )) as ContainerInfo;
  assertManager(next);
  if (!next.State.Running) {
    await docker.getContainer(next.Id).start();
  }
}

async function check(context: UpdateContext, journal: UpdateJournal) {
  await step(context, journal, "checking", "Checking the new manager's health");
  await managerHealth(context, journal.manager.version);
  await step(context, journal, "committing", "Committing the new manager");
  await commit(context, journal);
}

async function commit(context: UpdateContext, journal: UpdateJournal) {
  const previous = await inspectContainer(
    context.docker,
    previousManagerContainerName,
  );
  if (previous) {
    if (previous.Id !== journal.manager.previousContainerId)
      throw new Error("The previous manager was replaced");
    await context.docker.getContainer(previous.Id).remove({ force: true });
  }
  await pruneImages(context.docker, "manager", [journal.manager.fromImageId]);
  journal.manager.status = "updated";
  await finish(
    context.journal,
    journal,
    "updated",
    `Manager ${journal.manager.version} is up`,
    context.log,
  );
}

async function rollback(
  context: UpdateContext,
  journal: UpdateJournal,
  reason: string,
) {
  const { docker } = context;
  const target = journal.manager;
  journal.error = reason;
  await step(
    context,
    journal,
    "rolling-back",
    `Rolling back the manager: ${reason}`,
  );

  // Only a manager that can be put back is worth removing the current one.
  const previous = await inspectContainer(docker, previousManagerContainerName);
  if (previous) {
    if (previous.Id !== target.previousContainerId)
      throw new Error("The previous manager was replaced");
    const current = await inspectContainer(docker, managerContainerName);
    if (current && current.Id !== previous.Id) {
      assertManager(current);
      await docker.getContainer(current.Id).remove({ force: true });
    }
    await docker.getContainer(previous.Id).rename({
      name: managerContainerName,
    });
  }
  const restored = await inspectContainer(docker, managerContainerName);
  if (restored) assertManager(restored);
  if (restored && !restored.State.Running) {
    await docker.getContainer(restored.Id).start();
  }
  try {
    await managerHealth(context, target.fromVersion);
  } catch (error) {
    context.log(
      `update ${journal.id}: the previous manager is not healthy either: ${errorMessage(error)}`,
    );
  }
  target.status = "rolled-back";
  await finish(
    context.journal,
    journal,
    "rolled-back",
    `Manager ${target.fromVersion ?? "(previous)"} is back`,
    context.log,
  );
}

// The updater container's whole job. Each phase checks what is there, so a
// restarted updater picks up where the last one stopped.
export async function runUpdater(context: UpdateContext) {
  const journal = await context.journal.read();
  if (!journal || journal.phase !== "manager") {
    context.log("updater: no manager update to run");
    await context.docker
      .getContainer(updaterContainerName)
      .update({ RestartPolicy: { Name: "no" } })
      .catch(() => undefined);
    return;
  }

  try {
    if (journal.manager.status === "committing") {
      await commit(context, journal);
      return;
    }
    if (journal.manager.status === "rolling-back") {
      await rollback(context, journal, journal.error ?? "Interrupted");
      return;
    }
    if (journal.manager.status !== "checking") {
      await swap(context, journal);
    }
    await check(context, journal);
  } catch (error) {
    if (
      journal.manager.status === "committing" ||
      journal.manager.status === "updated"
    )
      throw error;
    await rollback(context, journal, errorMessage(error));
  } finally {
    // Done either way: keep the exited container for its logs, but make sure
    // Docker does not start it again.
    if ((await context.journal.read())?.phase === "done")
      await context.docker
        .getContainer(updaterContainerName)
        .update({ RestartPolicy: { Name: "no" } })
        .catch(() => undefined);
  }
}

// Runs in whichever manager starts while a manager update is unfinished. A
// running updater owns the journal; a lost one (after a reboot) is restarted
// a few times before recovery is left paused for repair.
export async function resumeManager(
  context: UpdateContext,
  journal: UpdateJournal,
) {
  const updater = await inspectContainer(context.docker, updaterContainerName);
  if (updater?.State.Running || updater?.State.Restarting) {
    return;
  }
  const attempts = journal.manager.attempts ?? 1;
  if (journal.manager.status === "pending") {
    await finish(
      context.journal,
      journal,
      "failed",
      "The manager's updater stopped before it finished",
      context.log,
    );
    return;
  }
  if (attempts >= maxUpdaterAttempts) {
    // The swap or rollback is still unfinished. Keep its recovery record and
    // keep new updates paused instead of letting one overwrite the journal.
    throw new Error("The manager's updater exhausted its recovery attempts");
  }
  journal.manager.attempts = attempts + 1;
  await note(
    context.journal,
    journal,
    "Restarting the manager's updater",
    context.log,
  );
  await startUpdater(context, journal);
}
