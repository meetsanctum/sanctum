import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import {
  assertManaged,
  ensureVolume,
  managedLabels,
  type Log,
} from "../docker-resources.js";
import {
  ensureImage,
  errorMessage,
  inspectContainer,
  inspectImage,
  isNotFound,
  tagOf,
  type DockerClientLike,
  type DockerContainerLike,
} from "../docker.js";
import { syncFileSystem, syncPath } from "../durable.js";
import { OperationConflictError, type Operations } from "../operations.js";
import { pruneSnapshots, snapshotName } from "../update/backup.js";
import {
  inspectService,
  removeUnusedImage,
  serviceContainerName,
  stopAndRemove,
  type ServiceSpec,
} from "./containers.js";
import type { ImageChange, ServicesStateStore } from "./state.js";

// A service's new version may migrate its data in place, with no way back, and
// Zigbee2MQTT's data holds the Zigbee network's key: without it every device
// has to be paired again. So before a service runs on another image than its
// data last saw, the manager copies its data volumes to /data/backups, beside
// the core's update snapshots, and then watches the new version. If it does
// not come up, the copy and the version before go back, and the service stays
// on that version until the manager brings another one.
//
// The reconcile loop drives this: each step is saved in services.json before
// it is taken, so a crash or reboot picks up where it stopped, and each pass
// judges the new version by what Docker counted meanwhile. A service has no
// health check to ask, so a version that keeps running but does not work
// counts as up; its copy is still kept.

type Volume = NonNullable<ServiceSpec["volumes"]>[number];

const keptCopies = 3;
// Running this long without a restart counts as up.
const settledForMs = 2 * 60_000;
// Docker restarting it this many times counts as not coming up. A single
// restart may be something else, such as a broker still starting.
const restartsBeforeGoingBack = 3;
// How long its time under observation keeps other operations waiting. One that
// neither settles nor fails, as while its coordinator is unplugged, is still judged
// on every pass, but mustn't block the update that would fix it.
const observedForAtMostMs = 10 * 60_000;

function copyPrefix(service: string) {
  return `${service}-`;
}

function tarOf(copy: string, volume: Volume) {
  return join(copy, `${volume.name}.tar`);
}

// Whether it holds the slot: putting one back has to finish, whatever else asks.
function holdsTheSlot(change: ImageChange) {
  if (change.status === "restoring") return true;
  return (
    change.status === "checking" &&
    Date.now() - Date.parse(change.startedAt ?? "") < observedForAtMostMs
  );
}

export function createImageChanges(options: {
  docker: DockerClientLike;
  store: ServicesStateStore;
  // The manager's backups folder.
  backupsDir: string;
  operations: Operations;
  log: Log;
  // Says why a service went down for this, for its status and the audit.
  onProblem: (service: string, problem: string) => void;
}) {
  const { docker, store, backupsDir, log } = options;
  options.operations.heldBy(() => {
    const changes = Object.entries(store.current().imageChanges ?? {});
    for (const [service, change] of changes) {
      if (holdsTheSlot(change)) {
        return { kind: "service-image", service, to: change.to };
      }
    }
    return null;
  });
  // The image a service could not get a copy for. A full disk must not stop
  // and start the service on every pass, so it stays on its version and a new
  // manager process, after an update or a reboot, tries again.
  const noCopy = new Map<string, string>();
  // The image each service waits to move to, and the one it stopped holding the
  // slot on, each said once rather than on every pass.
  const waitingToMove = new Map<string, string>();
  const stoppedHolding = new Map<string, string>();

  function saveChange(service: string, change: ImageChange | undefined) {
    return store.update((draft) => {
      draft.imageChanges ??= {};
      if (change) {
        draft.imageChanges[service] = change;
      } else {
        delete draft.imageChanges[service];
      }
    });
  }

  // A crash can leave the container behind, still holding its volume.
  async function removeCopyContainer(service: string) {
    const name = `${serviceContainerName(service)}-copy`;
    const stale = await inspectContainer(docker, name);
    if (stale) {
      assertManaged({ labels: stale.Config.Labels, name }, `${service}-copy`);
      await docker.getContainer(stale.Id).remove({ force: true, v: true });
    }
  }

  // Docker reads and writes a volume through a container that never starts,
  // so this asks nothing of the image: no shell, no tools, no entrypoint.
  async function withVolume(
    service: string,
    image: string,
    volume: Volume,
    use: (container: DockerContainerLike) => Promise<unknown>,
  ) {
    await removeCopyContainer(service);
    const name = `${serviceContainerName(service)}-copy`;
    await docker.createContainer({
      name,
      Image: image,
      Labels: managedLabels(`${service}-copy`),
      HostConfig: { Binds: [`${volume.name}:${volume.target}`] },
    });
    try {
      await use(docker.getContainer(name));
    } finally {
      await docker
        .getContainer(name)
        // Images can declare other, anonymous volumes; only the service's
        // named data volume should survive this temporary container.
        .remove({ force: true, v: true })
        .catch(() => undefined);
    }
  }

  async function keepCopy(service: string, spec: ServiceSpec, from: string) {
    const copy = join(
      backupsDir,
      snapshotName(copyPrefix(service), tagOf(from) ?? undefined),
    );
    const partial = `${copy}.partial`;
    await mkdir(partial, { recursive: true, mode: 0o700 });
    try {
      for (const volume of spec.volumes ?? []) {
        await ensureVolume(docker, volume.name);
        await withVolume(service, spec.image, volume, async (container) => {
          const archive = await container.getArchive({
            path: `${volume.target}/.`,
          });
          await pipeline(
            archive,
            createWriteStream(tarOf(partial, volume), { mode: 0o600 }),
          );
        });
      }
      await syncFileSystem(partial);
      await rename(partial, copy);
      await syncPath(backupsDir);
      return copy;
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      throw error;
    }
  }

  // An empty volume, not one emptied by hand, so nothing the new version
  // wrote stays. Docker refuses while a container still uses it. The volume's
  // own top folder gets what a new volume does; the files keep their owners.
  async function replaceVolume(
    service: string,
    image: string,
    volume: Volume,
    copy: string,
  ) {
    await ensureVolume(docker, volume.name);
    await docker
      .getVolume(volume.name)
      .remove()
      .catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    await ensureVolume(docker, volume.name);
    await withVolume(service, image, volume, (container) =>
      container.putArchive(createReadStream(tarOf(copy, volume)), {
        path: volume.target,
      }),
    );
  }

  // Puts the data and the version before back. It can simply run again if a
  // crash or reboot interrupts it, and until it ends nothing starts the
  // service on half its data.
  async function restore(
    service: string,
    change: ImageChange,
  ): Promise<ImageChange> {
    // Nothing goes until the copy is known to be there.
    for (const volume of change.volumes) {
      await access(tarOf(change.backup, volume));
    }
    await saveChange(service, { ...change, status: "restoring" });
    log(`Putting ${service} back on ${change.from}, instead of ${change.to}`);
    options.onProblem(
      service,
      `${change.to} did not come up, so the version before and its data are going back`,
    );

    const failed = await inspectService(docker, service);
    if (failed) await stopAndRemove(docker, failed.Id);
    await removeCopyContainer(service);
    await ensureImage(docker, change.from);
    for (const volume of change.volumes) {
      await replaceVolume(service, change.from, volume, change.backup);
    }
    // Docker wrote them, and the record below relies on them.
    await syncFileSystem(backupsDir);

    const kept: ImageChange = { ...change, status: "kept-back" };
    await store.update((draft) => {
      (draft.imageChanges ??= {})[service] = kept;
      (draft.images ??= {})[service] = change.from;
    });
    if (failed && failed.Config.Image !== change.from) {
      await removeUnusedImage(docker, failed.Image);
    }
    return kept;
  }

  function putBack(service: string, change: ImageChange) {
    // Observation can have given the slot up. Reserve it again, including
    // while the restoring record is being written, before touching any data.
    return options.operations.claim(
      { kind: "service-image", service, to: change.to },
      () => restore(service, change),
      { isContinuing: true },
    );
  }

  async function judge(service: string, change: ImageChange) {
    const container = await inspectService(docker, service);
    // A crash came before the swap, or nothing has asked for it since.
    if (container?.Config.Image !== change.to) return "waiting";
    // Its start failed on the last pass.
    if (container.State.Status === "created") return "failed";
    // One that crashed shows as restarting and Docker counts it, however soon
    // it crashed. One that has exited was stopped, by this manager while its
    // coordinator is unplugged or by a person, which says nothing of the
    // version, and the reconcile starts it again.
    if ((container.RestartCount ?? 0) >= restartsBeforeGoingBack) {
      return "failed";
    }
    const up = container.State.Running && !container.State.Restarting;
    const startedAt = Date.parse(container.State.StartedAt ?? "");
    return up && Date.now() - startedAt >= settledForMs ? "up" : "waiting";
  }

  async function commit(service: string, change: ImageChange) {
    await pruneSnapshots(backupsDir, copyPrefix(service), keptCopies);
    const old = await inspectImage(docker, change.from);
    if (old) await removeUnusedImage(docker, old.Id);
    await saveChange(service, undefined);
    log(`${service} stayed up on ${change.to}`);
  }

  // The image the service should run now, taking the next step of a change of
  // image, or starting one. Stops the service only to copy its data.
  async function imageToRun(service: string, spec: ServiceSpec) {
    const saved = store.current().imageChanges?.[service];
    // A version not yet judged goes back with a manager going back to the
    // version the copy was taken under.
    const change =
      saved?.status === "checking" && saved.from === spec.image
        ? await putBack(service, saved)
        : saved;

    if (change?.to === spec.image) {
      if (change.status === "kept-back") return change.from;
      const verdict = await judge(service, change);
      if (verdict === "failed") {
        await putBack(service, change);
        return change.from;
      }
      if (verdict === "up") await commit(service, change);
      else if (
        !holdsTheSlot(change) &&
        stoppedHolding.get(service) !== change.to
      ) {
        stoppedHolding.set(service, change.to);
        log(
          `${service} hasn't settled on ${change.to}, so others may go first`,
        );
      }
      return spec.image;
    }
    // The manager brought yet another version, which starts afresh. One kept back
    // keeps its record until it can, for the volumes its data went back to.
    if (change?.status === "checking") await saveChange(service, undefined);

    const existing = await inspectService(docker, service);
    const from = existing?.Config.Image ?? store.current().images?.[service];
    if (!from || from === spec.image) {
      if (change) await saveChange(service, undefined);
      return spec.image;
    }
    if (noCopy.get(service) === spec.image) return from;

    const begin = async () => {
      // Pull first, so a failed pull leaves the old container running.
      await ensureImage(docker, spec.image);
      log(`Keeping a copy of ${service}'s data before ${spec.image}`);
      // A graceful stop, so the copy holds what the service saved.
      if (existing?.State.Running) {
        await docker.getContainer(existing.Id).stop({ t: 10 });
      }
      let backup: string;
      try {
        backup = await keepCopy(service, spec, from);
      } catch (error) {
        const reason = errorMessage(error);
        log(`${service} stays on ${from}: no copy of its data: ${reason}`);
        options.onProblem(service, `No copy of its data: ${reason}`);
        noCopy.set(service, spec.image);
        return from;
      }
      await saveChange(service, {
        from,
        to: spec.image,
        backup,
        volumes: spec.volumes ?? [],
        status: "checking",
        startedAt: new Date().toISOString(),
      });
      return spec.image;
    };
    try {
      const image = await options.operations.claim(
        { kind: "service-image", service, to: spec.image },
        begin,
      );
      waitingToMove.delete(service);
      return image;
    } catch (error) {
      if (!(error instanceof OperationConflictError)) throw error;
      // It stays on its version, and a later pass tries again.
      if (waitingToMove.get(service) !== spec.image) {
        waitingToMove.set(service, spec.image);
        log(`${service} stays on ${from} for now: ${error.message}`);
      }
      return from;
    }
  }

  return {
    // A restore must finish even when nothing needs the service now or its
    // hardware is absent. Otherwise its journal would hold the slot forever.
    async resume(service: string) {
      const change = store.current().imageChanges?.[service];
      if (change?.status === "restoring") await putBack(service, change);
    },

    // What the service should run now. A version kept back stays with the
    // volumes its data went back to: a service started on any other, empty,
    // would begin again, and Zigbee2MQTT with a new network.
    async specToRun(service: string, spec: ServiceSpec): Promise<ServiceSpec> {
      const image = await imageToRun(service, spec);
      const change = store.current().imageChanges?.[service];
      return change?.status === "kept-back" && image === change.from
        ? { ...spec, image, volumes: change.volumes }
        : { ...spec, image };
    },

    // The service runs this image now, which is what its data will see next.
    // Without a container to ask, this tells the next change where it started.
    async ran(service: string, image: string) {
      if (store.current().images?.[service] === image) return;
      await store.update((draft) => {
        (draft.images ??= {})[service] = image;
      });
    },
  };
}
