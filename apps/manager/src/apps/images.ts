import { randomUUID } from "node:crypto";
import { access, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import { assertManaged, managedLabels, type Log } from "../docker-resources.js";
import { errorMessage, isNotFound, type DockerClientLike } from "../docker.js";
import { syncFileSystem, syncPath } from "../durable.js";
import { stacked } from "../stack.js";
import { readJson, writeJson } from "../state.js";
import { helperDataAt, type Helper } from "./helper.js";
import { AppRefusal } from "./refusal.js";

// Each app's data lives on an image of its own, a sparse ext4 file that holds it
// to its size and keeps a full disk from reaching anyone else. Nothing attaches
// an image but this, just before its app starts, so a boot needs no step of its
// own: it checks the image while nothing has it mounted, confirms it's the one
// recorded, and attaches it. Docker's local driver then mounts it for the app's
// container.
//
// A volume names its image by the filesystem's own id wherever the host has
// those, which can't answer to the wrong image. Docker Desktop has none, so a
// development stack's goes by loop number, tied again at each attach.

// discard gives the card its space back as files are deleted. sync leaves no
// dirty pages: without it, an app writing more than its memory limit in one go is
// killed for what's only cache, since writing it out through a loop device needs
// memory from the same limit. It costs about 18 ms a commit on an SD card, and
// every commit is then on the disk.
const mountOptions = "discard,sync";

const imagesFolder = "images";
const appUser = "1000:1000";
const mebibyte = 1024 * 1024;
// What an update needs free, which Settings → Status warns under too.
const keptForUpdates = 1536 * mebibyte;

export const defaultImageMb = 256;
export const smallestImageMb = 64;
export const largestImageMb = 4096;

export type ImageRecord = {
  uuid: string;
  sizeMb: number;
  // Set aside when its check failed, with where it went.
  damaged?: { at: string; file: string };
};
type ImagesState = { images: Record<string, ImageRecord> };

export type ImageStatus = {
  app: string;
  state: "ok" | "missing" | "damaged";
  sizeMb: number;
  // What it takes on the disk now.
  bytes: number;
};

export function imageVolumeName(app: string) {
  return stacked(`sanctum-app-data-${app}`);
}

export function createAppImages(options: {
  docker: Pick<DockerClientLike, "createVolume" | "getVolume">;
  // The manager's data volume, mounted here.
  dataDir: string;
  // The host's /dev, as the manager sees it, for /dev/disk/by-uuid.
  hostDevDir: string;
  helper: Helper;
  // What's free for files on the disk they're on, if known.
  free: () => Promise<number | null>;
  log: Log;
}) {
  const { docker, dataDir, hostDevDir, helper, free, log } = options;
  const folder = join(dataDir, imagesFolder);
  const statePath = join(dataDir, "images.json");
  const fileOf = (app: string) => join(folder, `${app}.img`);
  const seenByHelper = (name: string) =>
    `${helperDataAt}/${imagesFolder}/${name}`;

  const read = async () =>
    (await readJson<ImagesState>(statePath)) ?? { images: {} };

  async function note(app: string, record: ImageRecord) {
    const state = await read();
    state.images[app] = record;
    await writeJson(statePath, state);
  }

  async function exists(path: string) {
    return access(path).then(
      () => true,
      () => false,
    );
  }

  async function bytesOf(app: string) {
    return stat(fileOf(app)).then(
      ({ blocks }) => blocks * 512,
      () => 0,
    );
  }

  // What the images may still grow to, which the card has to keep for them.
  async function promised() {
    const { images } = await read();
    let bytes = 0;
    for (const [app, record] of Object.entries(images)) {
      if (record.damaged) continue;
      const file = await stat(fileOf(app)).catch(() => null);
      // Growth may have reached the disk just before saving its record failed.
      const capacity = Math.max(record.sizeMb * mebibyte, file?.size ?? 0);
      bytes += Math.max(0, capacity - (file?.blocks ?? 0) * 512);
    }
    return bytes;
  }

  async function assertRoom(app: string, more: number) {
    const available = await free();
    if (available === null) return;
    const left = available - (await promised()) - keptForUpdates;
    if (more > left) {
      throw new AppRefusal(
        `${app} needs ${Math.ceil(more / mebibyte)} MB for its data, and only ${Math.max(0, Math.floor(left / mebibyte))} MB can be spared`,
        409,
      );
    }
  }

  async function create(app: string, sizeMb: number) {
    await assertRoom(app, sizeMb * mebibyte);
    await mkdir(folder, { recursive: true });
    const uuid = randomUUID();
    const partial = seenByHelper(`${app}.img.partial`);
    const { code, output } = await helper(`set -e
truncate -s 0 ${partial}
truncate -s ${sizeMb}M ${partial}
mkfs.ext4 -F -q -m 10 -b 4096 -J size=8 -N 8192 -E root_owner=${appUser} -U ${uuid} ${partial}
sync -f ${partial}
mv ${partial} ${seenByHelper(`${app}.img`)}
`);
    if (code !== 0) {
      throw new Error(`Could not make ${app}'s image: ${output.trim()}`);
    }
    await syncPath(folder);
    const record = { uuid, sizeMb };
    await note(app, record);
    log(`Made ${app}'s image, ${sizeMb} MB`);
    return record;
  }

  // An image whose note a crash lost, or a file the record never knew: never
  // made anew over what may be someone's data.
  async function adopt(app: string, sizeMb: number) {
    const { code, output } = await helper(
      `tune2fs -l ${seenByHelper(`${app}.img`)} | awk '/Filesystem UUID/ {print $3}'`,
    );
    const uuid = output.trim();
    if (code !== 0 || !/^[0-9a-f-]{36}$/.test(uuid)) {
      return setAside(app, { uuid: "", sizeMb });
    }
    const size = Math.round((await stat(fileOf(app))).size / mebibyte);
    const record = { uuid, sizeMb: size };
    await note(app, record);
    return record;
  }

  async function setAside(app: string, record: ImageRecord): Promise<never> {
    const at = new Date().toISOString().replace(/[-:.]/g, "");
    const file = `${app}.damaged-${at}.img`;
    await rename(fileOf(app), join(folder, file));
    await syncPath(folder);
    await note(app, { ...record, damaged: { at, file } });
    log(`Set ${app}'s damaged image aside as ${file}`);
    throw new AppRefusal(`${app}'s data is damaged`, 409);
  }

  // Attached since the last boot, or checked and attached now.
  async function attach(app: string, record: ImageRecord) {
    const file = seenByHelper(`${app}.img`);
    const { code, output } = await helper(`file=${file}
uuid=$(tune2fs -l "$file" | awk '/Filesystem UUID/ {print $3}')
if [ "$uuid" != "${record.uuid}" ]; then
  echo "damaged: its id is $uuid"
  exit 20
fi
device=$(losetup -j "$file" -n -O NAME | head -1)
if [ -n "$device" ]; then
  echo "attached $device"
  exit 0
fi
e2fsck -fp "$file"
checked=$?
if [ "$checked" -ge 4 ]; then
  echo "damaged: e2fsck ended with $checked"
  exit 20
fi
# The kernel makes more loop devices as they're needed, but a container's /dev
# holds only those there when it started.
free=$(losetup -f | cut -d' ' -f1)
[ -e "$free" ] || mknod "$free" b 7 "\${free#/dev/loop}"
device=$(losetup -f --show "$file") || exit 21
echo "attached $device"
`);
    if (code === 20) {
      log(`${app}'s image failed its check: ${output.trim().slice(-200)}`);
      return setAside(app, record);
    }
    const device = /attached (\/dev\/loop\d+)/.exec(output)?.[1];
    if (code !== 0 || !device) {
      throw new Error(`Could not attach ${app}'s image: ${output.trim()}`);
    }
    return device;
  }

  // Udev names a new device a moment after it's attached.
  async function deviceFor(record: ImageRecord, loop: string) {
    const disks = join(hostDevDir, "disk");
    if (!(await exists(disks))) return loop;
    const byId = join(disks, "by-uuid", record.uuid);
    for (let tries = 0; tries < 20; tries++) {
      if (await exists(byId)) return `/dev/disk/by-uuid/${record.uuid}`;
      await new Promise((done) => setTimeout(done, 100));
    }
    return loop;
  }

  async function tie(
    app: string,
    device: string,
    releaseVolume?: () => Promise<void>,
  ) {
    const name = imageVolumeName(app);
    const volume = docker.getVolume(name);
    const wanted = { type: "ext4", device, o: mountOptions };
    const found = await volume.inspect().catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (found) {
      assertManaged(
        { labels: found.Labels, name: `${name} volume` },
        "app-data",
      );
      const { type, device: tied, o } = found.Options ?? {};
      if (type === wanted.type && tied === device && o === wanted.o) {
        return name;
      }
      // Docker keeps a stopped container's references too. Its owner releases
      // those only when the volume really needs to be tied again.
      await releaseVolume?.();
      await volume.remove();
    }
    await docker.createVolume({
      Name: name,
      Driver: "local",
      DriverOpts: wanted,
      Labels: managedLabels("app-data"),
    });
    return name;
  }

  return {
    // The volume with the app's data, made the first time. A record whose file
    // has gone stops the app, rather than giving it an empty folder. Refuses
    // before anything that runs is touched.
    async ensure(
      app: string,
      sizeMb: number,
      releaseVolume?: () => Promise<void>,
    ) {
      let record = (await read()).images[app];
      if (record?.damaged) {
        throw new AppRefusal(`${app}'s data is damaged`, 409);
      }
      const hasFile = await exists(fileOf(app));
      if (record && !hasFile) {
        throw new AppRefusal(`${app}'s data is missing`, 409);
      }
      record ??= hasFile ? await adopt(app, sizeMb) : await create(app, sizeMb);
      const loop = await attach(app, record);
      return tie(app, await deviceFor(record, loop), releaseVolume);
    },

    // Larger only, while nothing has it mounted, which frees a full image.
    async grow(app: string, sizeMb: number) {
      const record = (await read()).images[app];
      if (!record) throw new AppRefusal(`${app} has no image yet`, 404);
      if (record.damaged) {
        throw new AppRefusal(`${app}'s data is damaged`, 409);
      }
      if (!(await exists(fileOf(app)))) {
        throw new AppRefusal(`${app}'s data is missing`, 409);
      }
      if (sizeMb <= record.sizeMb) {
        throw new AppRefusal(`${app}'s image is already that large`, 400);
      }
      const actualMb = Math.ceil((await stat(fileOf(app))).size / mebibyte);
      if (sizeMb < actualMb) {
        throw new AppRefusal(`${app}'s image is already that large`, 400);
      }
      await assertRoom(
        app,
        (sizeMb - Math.max(record.sizeMb, actualMb)) * mebibyte,
      );
      const file = seenByHelper(`${app}.img`);
      const { code, output } = await helper(`set -e
file=${file}
uuid=$(tune2fs -l "$file" | awk '/Filesystem UUID/ {print $3}')
if [ "$uuid" != "${record.uuid}" ]; then
  echo "damaged: its id is $uuid"
  exit 20
fi
truncate -s ${sizeMb}M "$file"
device=$(losetup -j "$file" -n -O NAME | head -1)
if [ -n "$device" ]; then
  losetup --set-capacity "$device"
  target=$device
else
  target=$file
fi
e2fsck -fp "$target" || [ "$?" -lt 4 ]
resize2fs "$target"
sync -f "$file"
`);
      if (code === 20) return setAside(app, record);
      if (code !== 0) {
        throw new Error(`Could not grow ${app}'s image: ${output.trim()}`);
      }
      await syncFileSystem(fileOf(app));
      await note(app, { ...record, sizeMb });
      log(`Grew ${app}'s image to ${sizeMb} MB`);
    },

    async has(app: string) {
      const record = (await read()).images[app];
      // A damaged image still belongs to an app that has run. Its previous
      // package must survive Free up space so the data can be recovered.
      return record !== undefined;
    },

    async list(): Promise<ImageStatus[]> {
      const { images } = await read();
      const statuses: ImageStatus[] = [];
      for (const [app, record] of Object.entries(images)) {
        const hasFile = await exists(fileOf(app));
        statuses.push({
          app,
          state: record.damaged ? "damaged" : hasFile ? "ok" : "missing",
          sizeMb: record.sizeMb,
          bytes: record.damaged
            ? await stat(join(folder, record.damaged.file)).then(
                ({ blocks }) => blocks * 512,
                () => 0,
              )
            : await bytesOf(app),
        });
      }
      return statuses;
    },

    // For what asks whether anything's wrong, which must not fail because of it.
    async listOrNone() {
      return this.list().catch((error: unknown) => {
        log(`Could not read apps' images: ${errorMessage(error)}`);
        return [] as ImageStatus[];
      });
    },
  };
}

export type AppImages = ReturnType<typeof createAppImages>;
