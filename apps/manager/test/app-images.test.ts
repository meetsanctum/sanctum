import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Helper } from "../src/apps/helper.js";
import { createAppImages, imageVolumeName } from "../src/apps/images.js";
import { FakeDocker } from "./fake-docker.js";

const durable = vi.hoisted(() => ({ synced: [] as string[] }));
vi.mock("../src/durable.js", async (original) => ({
  ...(await original<typeof import("../src/durable.js")>()),
  syncFileSystem: async (path: string) => void durable.synced.push(path),
}));

const app = "sanctum.weather";
const mebibyte = 1024 * 1024;
const gibibyte = 1024 * mebibyte;
const volume = imageVolumeName(app);

// The privileged helper, as far as the manager can tell: real files, and what
// e2fsck and losetup would have said. Real ones run in app-images.docker.ts.
function fakeHelper(folder: string) {
  const state = {
    scripts: [] as string[],
    attached: new Map<string, string>(),
    uuidOnDisk: undefined as string | undefined,
    check: { code: 0, output: "" },
    failNext: null as { code: number; output: string } | null,
  };
  const helper: Helper = async (script) => {
    state.scripts.push(script);
    if (state.failNext) {
      const failure = state.failNext;
      state.failNext = null;
      return failure;
    }
    if (script.includes("mkfs.ext4")) {
      const name = /mv \S+\/(\S+\.img\.partial) /.exec(script)![1]!;
      await writeFile(join(folder, name.replace(".partial", "")), "an image");
      state.uuidOnDisk = /-U (\S+)/.exec(script)![1]!;
      return { code: 0, output: "" };
    }
    const expectedUuid = /"\$uuid" != "([^"]+)"/.exec(script)?.[1];
    if (expectedUuid && expectedUuid !== state.uuidOnDisk) {
      return { code: 20, output: "damaged: its id is different" };
    }
    if (script.includes("resize2fs")) return { code: 0, output: "" };
    if (script.includes("losetup -f --show")) {
      const name = /file=\S+\/(\S+\.img)/.exec(script)![1]!;
      if (state.attached.has(name)) {
        return { code: 0, output: `attached ${state.attached.get(name)}\n` };
      }
      if (state.check.code !== 0) return state.check;
      const device = `/dev/loop${state.attached.size + 1}`;
      state.attached.set(name, device);
      return { code: 0, output: `attached ${device}\n` };
    }
    if (script.includes("Filesystem UUID")) {
      return { code: 0, output: `${state.uuidOnDisk ?? ""}\n` };
    }
    throw new Error(`The fake helper doesn't know: ${script}`);
  };
  return { helper, state };
}

async function setup(options: { free?: number | null; byId?: boolean } = {}) {
  const docker = new FakeDocker();
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-images-"));
  const folder = join(dataDir, "images");
  await mkdir(folder);
  const hostDevDir = await mkdtemp(join(tmpdir(), "sanctum-dev-"));
  if (options.byId) {
    await mkdir(join(hostDevDir, "disk/by-uuid"), { recursive: true });
  }
  const log = vi.fn();
  const { helper, state } = fakeHelper(folder);
  const free =
    options.free === undefined ? 8 * gibibyte : (options.free as number | null);
  const images = createAppImages({
    docker,
    dataDir,
    hostDevDir,
    helper,
    free: async () => free,
    log,
  });
  const records = async () =>
    JSON.parse(await readFile(join(dataDir, "images.json"), "utf8")) as {
      images: Record<string, { uuid: string; sizeMb: number }>;
    };
  return { dataDir, docker, folder, hostDevDir, images, log, records, state };
}

beforeEach(() => {
  durable.synced = [];
});

describe("an app's image", () => {
  it("is made once, the first time, and recorded", async () => {
    const { images, records, state } = await setup();

    await images.ensure(app, 256);
    await images.ensure(app, 256);

    expect(state.scripts.filter((s) => s.includes("mkfs.ext4"))).toHaveLength(
      1,
    );
    const { uuid, sizeMb } = (await records()).images[app]!;
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(sizeMb).toBe(256);
  });

  it("is formatted as the Pi showed it should be, with space kept for root", async () => {
    const { images, state, records } = await setup();

    await images.ensure(app, 128);

    const script = state.scripts[0]!;
    const { uuid } = (await records()).images[app]!;
    expect(script).toContain("truncate -s 128M");
    expect(script).toContain(
      `mkfs.ext4 -F -q -m 10 -b 4096 -J size=8 -N 8192 -E root_owner=1000:1000 -U ${uuid}`,
    );
    // On the disk before it takes its name.
    expect(script.indexOf("sync -f")).toBeLessThan(script.indexOf("mv "));
  });

  it("is checked and confirmed before it's attached", async () => {
    const { images, state, records } = await setup();

    await images.ensure(app, 256);

    const attach = state.scripts.find((s) => s.includes("losetup -f"))!;
    const { uuid } = (await records()).images[app]!;
    expect(attach.indexOf("e2fsck -fp")).toBeLessThan(
      attach.indexOf("losetup -f --show"),
    );
    expect(attach).toContain(`"$uuid" != "${uuid}"`);
  });
});

describe("the volume it's mounted through", () => {
  it("goes by loop number where the host has no filesystem ids", async () => {
    const { docker, images } = await setup();

    await expect(images.ensure(app, 256)).resolves.toBe(volume);

    expect(docker.volumeOptions.get(volume)).toEqual({
      type: "ext4",
      device: "/dev/loop1",
      // discard gives space back; sync keeps cache from killing the app.
      o: "discard,sync",
    });
    expect(docker.volumes.get(volume)).toMatchObject({
      "sanctum.managed": "true",
    });
  });

  it("goes by the filesystem's id where the host has them", async () => {
    const { docker, hostDevDir, images, records, state } = await setup({
      byId: true,
    });
    // Udev names it as soon as it's attached.
    const real = state.attached.set.bind(state.attached);
    state.attached.set = (name, device) => {
      void records().then(({ images: all }) =>
        writeFile(join(hostDevDir, "disk/by-uuid", all[app]!.uuid), ""),
      );
      return real(name, device);
    };

    await images.ensure(app, 256);

    const { uuid } = (await records()).images[app]!;
    expect(docker.volumeOptions.get(volume)?.device).toBe(
      `/dev/disk/by-uuid/${uuid}`,
    );
  });

  it("is tied again when its image comes back at another number", async () => {
    const { docker, images, state } = await setup();
    await images.ensure(app, 256);

    state.attached.clear();
    state.attached.set("other.img", "/dev/loop1");
    await images.ensure(app, 256);

    expect(docker.volumeOptions.get(volume)?.device).toBe("/dev/loop2");
    expect(docker.events).toContain(`remove volume ${volume}`);
  });

  it("is left alone when nothing changed", async () => {
    const { docker, images } = await setup();
    await images.ensure(app, 256);
    docker.events = [];

    await images.ensure(app, 256);

    expect(docker.events).toEqual([]);
  });

  it("releases old container references only when the device changes", async () => {
    const { images, state, docker } = await setup();
    const releaseVolume = vi.fn(async () => {
      expect(docker.volumes.has(volume)).toBe(true);
    });
    await images.ensure(app, 256, releaseVolume);
    await images.ensure(app, 256, releaseVolume);
    expect(releaseVolume).not.toHaveBeenCalled();

    state.attached.clear();
    state.attached.set("other.img", "/dev/loop1");
    await images.ensure(app, 256, releaseVolume);

    expect(releaseVolume).toHaveBeenCalledOnce();
    expect(docker.volumeOptions.get(volume)?.device).toBe("/dev/loop2");
  });

  it("refuses a volume of that name that isn't its own", async () => {
    const { docker, images } = await setup();
    docker.volumes.set(volume, { "sanctum.stack": "someone-else" });

    await expect(images.ensure(app, 256)).rejects.toThrow("Refusing to manage");
  });

  it("refuses an unlabelled volume even when it belongs to no other stack", async () => {
    const { docker, images } = await setup();
    docker.volumes.set(volume, {});
    docker.volumeOptions.set(volume, {
      type: "ext4",
      device: "/dev/loop1",
      o: "discard",
    });

    await expect(images.ensure(app, 256)).rejects.toThrow("Refusing to manage");
    expect(docker.volumes.get(volume)).toEqual({});
  });
});

describe("when the image isn't right", () => {
  it("stops the app when its image has gone, rather than make an empty one", async () => {
    const { folder, images, state } = await setup();
    await images.ensure(app, 256);
    await rename(join(folder, `${app}.img`), join(folder, "moved-away"));
    const made = state.scripts.length;

    await expect(images.ensure(app, 256)).rejects.toMatchObject({
      status: 409,
      message: `${app}'s data is missing`,
    });

    expect(state.scripts).toHaveLength(made);
    expect(await images.list()).toMatchObject([{ app, state: "missing" }]);
  });

  it("sets a damaged image aside, and doesn't make a new one", async () => {
    const { folder, images, state } = await setup();
    await images.ensure(app, 256);
    state.attached.clear();
    state.check = { code: 20, output: "damaged: e2fsck ended with 8" };

    await expect(images.ensure(app, 256)).rejects.toMatchObject({
      status: 409,
      message: `${app}'s data is damaged`,
    });

    const files = await readdir(folder);
    expect(files.some((file) => file.includes(".damaged-"))).toBe(true);
    expect(files).not.toContain(`${app}.img`);
    expect(await images.list()).toMatchObject([{ app, state: "damaged" }]);
    expect(await images.has(app)).toBe(true);

    // And stays stopped, without trying again.
    const scripts = state.scripts.length;
    await expect(images.ensure(app, 256)).rejects.toThrow("damaged");
    expect(state.scripts).toHaveLength(scripts);
  });

  it("adopts an image whose note a crash lost, rather than make it anew", async () => {
    const { folder, images, records, state } = await setup();
    await writeFile(join(folder, `${app}.img`), "someone's data");
    state.uuidOnDisk = "11111111-2222-4333-8444-555555555555";

    await images.ensure(app, 256);

    expect(await readFile(join(folder, `${app}.img`), "utf8")).toBe(
      "someone's data",
    );
    expect(state.scripts.some((s) => s.includes("mkfs.ext4"))).toBe(false);
    expect((await records()).images[app]?.uuid).toBe(state.uuidOnDisk);
  });

  it("says when it couldn't be made, and records nothing", async () => {
    const { dataDir, images, state } = await setup();
    state.failNext = { code: 1, output: "mkfs.ext4: No space left" };

    await expect(images.ensure(app, 256)).rejects.toThrow(
      "Could not make sanctum.weather's image: mkfs.ext4: No space left",
    );

    await expect(readFile(join(dataDir, "images.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("what the card keeps for images", () => {
  it("refuses one that wouldn't leave room for updates", async () => {
    const { images, state } = await setup({
      free: 1536 * mebibyte + 100 * mebibyte,
    });

    await expect(images.ensure(app, 256)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("only 100 MB can be spared"),
    });
    expect(state.scripts).toEqual([]);
  });

  it("counts what the others may still grow to", async () => {
    const { images } = await setup({
      free: 1536 * mebibyte + 400 * mebibyte,
    });
    await images.ensure(app, 256);

    await expect(images.ensure("sanctum.moods", 256)).rejects.toThrow(
      "only 144 MB can be spared",
    );
  });

  it("keeps room for growth that hasn't reached its record yet", async () => {
    const { folder, images } = await setup({
      free: 1536 * mebibyte + 700 * mebibyte,
    });
    await images.ensure(app, 256);
    await truncate(join(folder, `${app}.img`), 512 * mebibyte);

    await expect(images.ensure("sanctum.moods", 256)).rejects.toThrow(
      "can be spared",
    );
  });

  it("goes ahead when it can't tell what's free", async () => {
    const { images } = await setup({ free: null });

    await expect(images.ensure(app, 256)).resolves.toBe(volume);
  });
});

describe("growing one", () => {
  it("grows it, syncs and records it", async () => {
    const { images, records, state } = await setup();
    await images.ensure(app, 256);

    await images.grow(app, 512);

    const script = state.scripts.at(-1)!;
    expect(script).toContain("truncate -s 512M");
    expect(script).toContain("resize2fs");
    expect((await records()).images[app]?.sizeMb).toBe(512);
    expect(durable.synced.length).toBeGreaterThan(0);
  });

  it.each([
    ["smaller", 128, 400],
    ["the same", 256, 400],
  ])("refuses a size that's %s", async (_case, size, status) => {
    const { images } = await setup();
    await images.ensure(app, 256);

    await expect(images.grow(app, size)).rejects.toMatchObject({ status });
  });

  it("refuses more than the card can spare", async () => {
    const { images } = await setup({
      free: 1536 * mebibyte + 300 * mebibyte,
    });
    await images.ensure(app, 64);

    await expect(images.grow(app, 512)).rejects.toThrow("can be spared");
  });

  it("refuses an app with no image", async () => {
    const { images } = await setup();

    await expect(images.grow(app, 512)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to grow an image with a different identity", async () => {
    const { images, state } = await setup();
    await images.ensure(app, 256);
    state.uuidOnDisk = "11111111-2222-4333-8444-555555555555";

    await expect(images.grow(app, 512)).rejects.toMatchObject({ status: 409 });

    expect(await images.list()).toMatchObject([{ app, state: "damaged" }]);
  });

  it("never shortens a file whose growth finished before its record was saved", async () => {
    const { folder, images, state } = await setup();
    await images.ensure(app, 256);
    await truncate(join(folder, `${app}.img`), 512 * mebibyte);
    const scripts = state.scripts.length;

    await expect(images.grow(app, 384)).rejects.toMatchObject({ status: 400 });
    expect(state.scripts).toHaveLength(scripts);
  });

  it("can finish recording growth after a failure", async () => {
    const { folder, images, records } = await setup();
    await images.ensure(app, 256);
    await truncate(join(folder, `${app}.img`), 512 * mebibyte);

    await images.grow(app, 512);

    expect((await records()).images[app]?.sizeMb).toBe(512);
  });
});
