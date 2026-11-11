import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { coreVolumeName, managerDataVolumeName } from "../core-container.js";
import { assertManaged, managedLabels, type Log } from "../docker-resources.js";
import { ensureImage, inspectContainer } from "../docker.js";
import { syncFileSystem, syncPath } from "../durable.js";
import type { SpaceDockerLike } from "../host/space.js";
import { stacked } from "../stack.js";
import type { DockerClientLike } from "../docker.js";
import { AppRefusal } from "./refusal.js";

// A short container that reaches one app's image, for what the app can't do for
// itself: copying its database while it runs, putting a copy back while it's
// stopped, exporting one file, and taking in its file from the core's data on its
// first move, read-only so that file stays as it was. It runs as root, which alone
// may use the space
// each image keeps back, with only what touching the app's files needs. It uses
// Node's own SQLite, so it needs no app's package and no network.

const copiesFolder = "app-copies";
const copiesAt = "/copies";
const dataAt = "/data";
const originalAt = "/original";
const resultFile = ".result";
const appUser = { uid: 1000, gid: 1000 };

export const maintenanceFilePattern = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

// The most any of this may take, since other work on apps' images waits for it. A copy
// of the largest image on an SD card takes well under this.
const defaultLimitMs = 5 * 60_000;

export type MaintenanceOperation = "copy" | "restore" | "export" | "adopt";
export type MaintenanceRequest = {
  operation: MaintenanceOperation;
  // The file in the app's data, as named there.
  file: string;
  // Its copy's name in the app's copies, or to adopt, the file's in the core's apps.
  name: string;
};

// Writes what happened where the manager can read it, since it can't read logs
// through what it's given. A copy appears under its name only once it's whole and
// synced. Putting one back leaves no stale WAL behind it. Only one of these runs for
// an app at a time, so anything left under the prefix is from a run the power cut
// short, which nothing picks up again, and the next run clears it. Opening a database
// in WAL mode leaves two more files beside it, even if only to read it.
const script = `
  import { randomUUID } from "node:crypto";
  import { constants, closeSync, copyFileSync, chownSync, fsyncSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
  import { backup, DatabaseSync } from "node:sqlite";
  const [operation, file, name, uid, gid] = process.argv.slice(1);
  const sync = (path) => { const fd = openSync(path, "r"); fsyncSync(fd); closeSync(fd); };
  const source = "${dataAt}/" + file;
  const copy = "${copiesAt}/" + name;
  const prefix = ".maintenance-";
  const isPlaced = operation === "restore" || operation === "adopt";
  const temporary = (isPlaced ? "${dataAt}" : "${copiesAt}") + "/" + prefix + randomUUID();
  const report = (result) => writeFileSync("${copiesAt}/${resultFile}", JSON.stringify(result));
  const clearLeftovers = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(prefix)) rmSync(folder + "/" + entry.name, { force: true });
    }
  };
  try {
    clearLeftovers("${copiesAt}");
    clearLeftovers("${dataAt}");
    if (operation === "copy") {
      statSync(source);
      const db = new DatabaseSync(source, { readOnly: true });
      await backup(db, temporary);
      db.close();
      const check = new DatabaseSync(temporary, { readOnly: true });
      const { quick_check: verdict } = check.prepare("pragma quick_check").get();
      check.close();
      if (verdict !== "ok") throw new Error("The copy failed its check: " + verdict);
    } else if (operation === "export") {
      copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    } else {
      if (operation === "adopt") {
        // What a core that died left in its WAL comes too, settled into the copy,
        // since the original's mount can't take the files SQLite would want beside it.
        const original = "${originalAt}/apps/" + name;
        statSync(original);
        copyFileSync(original, temporary, constants.COPYFILE_EXCL);
        try {
          copyFileSync(original + "-wal", temporary + "-wal", constants.COPYFILE_EXCL);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const db = new DatabaseSync(temporary);
        db.exec("pragma wal_checkpoint(TRUNCATE)");
        const { quick_check: verdict } = db.prepare("pragma quick_check").get();
        db.close();
        if (verdict !== "ok") throw new Error("The copy failed its check: " + verdict);
        for (const left of [temporary + "-wal", temporary + "-shm"]) rmSync(left, { force: true });
      } else {
        statSync(copy);
        copyFileSync(copy, temporary, constants.COPYFILE_EXCL);
      }
      chownSync(temporary, Number(uid), Number(gid));
      sync(temporary);
      for (const stale of [source + "-wal", source + "-shm", source + "-journal"]) rmSync(stale, { force: true });
      renameSync(temporary, source);
      sync("${dataAt}");
      report({ ok: true, bytes: statSync(source).size });
      process.exit(0);
    }
    sync(temporary);
    renameSync(temporary, copy);
    report({ ok: true, bytes: statSync(copy).size });
  } catch (error) {
    report({ ok: false, code: error.code ?? null, message: String(error.message) });
    process.exitCode = 1;
  } finally {
    for (const left of [temporary, temporary + "-wal", temporary + "-shm"]) rmSync(left, { force: true });
  }
`;

export function createMaintenance(options: {
  docker: Pick<SpaceDockerLike, "getContainer"> & DockerClientLike;
  dataDir: string;
  nodeImage: string;
  log: Log;
  limitMs?: number;
}) {
  const { docker, dataDir, nodeImage, log } = options;
  const limitMs = options.limitMs ?? defaultLimitMs;
  const role = "app-maintenance";
  const nameOf = (app: string) => stacked(`sanctum-app-maintenance-${app}`);

  async function prepare(app: string) {
    const name = nameOf(app);
    const stale = await inspectContainer(docker, name);
    if (stale) {
      assertManaged({ labels: stale.Config.Labels, name }, role);
      await docker.getContainer(stale.Id).remove({ force: true, v: true });
    }
  }

  return {
    // A helper can outlive the manager, holding its image mounted or keeping a
    // reference to its volume. Release it before any new work on that image.
    prepare,

    async run(app: string, volume: string, request: MaintenanceRequest) {
      const name = nameOf(app);
      await prepare(app);
      const copies = join(dataDir, copiesFolder, app);
      await mkdir(copies, { recursive: true, mode: 0o700 });
      await ensureImage(docker, nodeImage);
      const { id } = await docker.createContainer({
        name,
        Image: nodeImage,
        Cmd: [
          "node",
          "--no-warnings",
          "--input-type=module",
          "-e",
          script,
          request.operation,
          request.file,
          request.name,
          String(appUser.uid),
          String(appUser.gid),
        ],
        Labels: managedLabels(role),
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          Tmpfs: { "/tmp": "size=16m" },
          CapDrop: ["ALL"],
          CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
          SecurityOpt: ["no-new-privileges"],
          RestartPolicy: { Name: "no" },
          Mounts: [
            {
              Type: "volume",
              Source: volume,
              Target: dataAt,
              VolumeOptions: { NoCopy: true },
            },
            {
              Type: "volume",
              Source: managerDataVolumeName,
              Target: copiesAt,
              VolumeOptions: {
                NoCopy: true,
                Subpath: `${copiesFolder}/${app}`,
              },
            },
            ...(request.operation === "adopt"
              ? [
                  {
                    Type: "volume" as const,
                    Source: coreVolumeName,
                    Target: originalAt,
                    ReadOnly: true,
                    VolumeOptions: { NoCopy: true },
                  },
                ]
              : []),
          ],
        },
      });
      const container = docker.getContainer(id);
      const resultPath = join(copies, resultFile);
      try {
        await unlink(resultPath).catch(() => undefined);
        log(`${request.operation} on ${app}'s ${request.file}`);
        await container.start();
        let timer: NodeJS.Timeout | undefined;
        const isDone = await Promise.race([
          container.wait().then(() => true),
          new Promise<boolean>((done) => {
            timer = setTimeout(() => done(false), limitMs);
          }),
        ]).finally(() => clearTimeout(timer));
        if (!isDone) {
          throw new AppRefusal(
            `Could not ${request.operation} ${app}'s ${request.file} in time`,
            500,
          );
        }
        const result = JSON.parse(
          await readFile(resultPath, "utf8").catch(() => "{}"),
        ) as { ok?: boolean; bytes?: number; code?: string; message?: string };
        if (!result.ok) {
          const status = result.code === "ENOENT" ? 404 : 500;
          throw new AppRefusal(
            `Could not ${request.operation} ${app}'s ${request.file}: ${result.message ?? "it ended without saying"}`,
            status,
          );
        }
        // Docker's writes, which what comes next relies on.
        await syncFileSystem(copies);
        await syncPath(copies);
        return { bytes: result.bytes ?? 0 };
      } finally {
        await unlink(resultPath).catch(() => undefined);
        await container.remove({ force: true, v: true }).catch(() => undefined);
      }
    },
  };
}

export type Maintenance = ReturnType<typeof createMaintenance>;
