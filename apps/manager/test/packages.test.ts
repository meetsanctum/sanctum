import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPackages,
  digestOf,
  type PackagesState,
} from "../src/update/packages.js";
import { archiveOf, FakeDocker, type ArchivedFile } from "./fake-docker.js";

const durable = vi.hoisted(() => ({
  onFileSystemSync: async (_path: string) => {},
}));

vi.mock("../src/durable.js", async (original) => ({
  ...(await original<typeof import("../src/durable.js")>()),
  syncFileSystem: (path: string) => durable.onFileSystemSync(path),
}));

const shippedAt = "/app/catalog/official/.";
const reader = "sanctum-packages-reader";
const writer = "sanctum-packages-writer";
let builds = 0;

// An app as the core's image ships it, under the folder it's built in.
function app(
  folder: string,
  id: string,
  version: string,
  code = "export default {}",
): Record<string, ArchivedFile> {
  return {
    [`${folder}/sanctum-app.json`]: JSON.stringify({ id, version }),
    [`${folder}/dist/index.js`]: code,
    [`${folder}/node_modules/zod`]: { link: ".pnpm/zod@4/node_modules/zod" },
  };
}

function setup() {
  const docker = new FakeDocker();
  const log = vi.fn();
  // A core image that ships these files, or nothing, as a stack's does.
  const image = (files?: Record<string, ArchivedFile>) => {
    builds += 1;
    const id = docker.load(`sanctum-core:${builds}`, {
      title: "sanctum-core",
      version: `${builds}`,
    });
    if (files) {
      docker.imageArchives.set(id, new Map([[shippedAt, archiveOf(files)]]));
    }
    return id;
  };
  return { docker, log, image };
}

async function started() {
  const { docker, log, image } = setup();
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-packages-"));
  docker.volumeFolders.set("sanctum-manager-data", dataDir);
  const packages = createPackages({ docker, dataDir, log });
  const root = join(dataDir, "packages");
  return {
    dataDir,
    docker,
    image,
    log,
    packages,
    root,
    state: async () =>
      JSON.parse(
        await readFile(join(dataDir, "packages.json"), "utf8"),
      ) as PackagesState,
    folders: async (id: string) =>
      (await readdir(join(root, id)).catch(() => [])).sort(),
    created: () =>
      docker.events.filter((event) => event.startsWith(`create ${reader}`))
        .length,
  };
}

beforeEach(() => {
  durable.onFileSystemSync = async () => {};
});

describe("staging the apps' packages", () => {
  it("copies each app from the core's image to a folder of its own, and notes it", async () => {
    const { docker, image, packages, root, state } = await started();
    const core = image({
      ...app("weather", "sanctum.weather", "0.3.0", "weather"),
      ...app("zigbee", "sanctum.zigbee", "0.5.0", "zigbee"),
    });

    await packages.stage(core);

    const { apps, image: from } = await state();
    expect(from).toBe(core);
    const weather = apps["sanctum.weather"]!.current;
    expect(weather.version).toBe("0.3.0");
    expect(weather.folder).toMatch(/^0\.3\.0\+[0-9a-f]{16}$/);
    expect(apps["sanctum.weather"]!.previous).toBeUndefined();
    expect(apps["sanctum.zigbee"]!.current.version).toBe("0.5.0");
    expect(
      await readFile(
        join(root, "sanctum.weather", weather.folder, "dist/index.js"),
        "utf8",
      ),
    ).toBe("weather");
    const entry = await lstat(
      join(root, "sanctum.weather", weather.folder, "node_modules/zod"),
    );
    expect(entry.isSymbolicLink()).toBe(true);
    expect((await readdir(root)).sort()).toEqual([
      "sanctum.weather",
      "sanctum.zigbee",
    ]);
    expect(docker.container(reader)).toBeUndefined();
    expect(docker.container(writer)).toBeUndefined();
    // Images can declare volumes of their own, which go with the helpers.
    expect(docker.removedKeepingVolumes).toEqual([]);
  });

  it("reads and writes through containers that never start, one each", async () => {
    const { docker, image, log, packages, state } = await started();
    const core = image(app("weather", "sanctum.weather", "0.3.0"));

    await packages.stage(core);

    expect(log.mock.calls.flat().join()).not.toContain("Could not");
    expect((await state()).image).toBe(core);
    expect(docker.events).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^create ${reader} `)),
        expect.stringMatching(new RegExp(`^create ${writer} `)),
        `remove ${reader}`,
        `remove ${writer}`,
      ]),
    );
    expect(docker.events).not.toContain(`start ${reader}`);
    expect(docker.events).not.toContain(`start ${writer}`);
  });

  it("has nothing to do for an image it has staged", async () => {
    const { created, image, packages } = await started();
    const core = image(app("weather", "sanctum.weather", "0.3.0"));
    await packages.stage(core);

    await packages.stage(core);

    expect(created()).toBe(1);
  });

  it.each(["0.3.0+arm64", "0.3.0-rc.1+build.001"])(
    "stages a version with build metadata: %s",
    async (version) => {
      const { image, packages, state } = await started();

      await packages.stage(image(app("weather", "sanctum.weather", version)));

      const { current } = (await state()).apps["sanctum.weather"]!;
      expect(current.version).toBe(version);
      expect(current.folder.startsWith(`${version}+`)).toBe(true);
    },
  );

  it.each(["sanctum.weather--local", "sanctum.weather-"])(
    "stages a valid app id with consecutive or trailing hyphens: %s",
    async (id) => {
      const { image, packages, state } = await started();

      await packages.stage(image(app("weather", id, "0.3.0")));

      expect((await state()).apps[id]?.current.version).toBe("0.3.0");
    },
  );

  it("gives a new build of the same version a folder of its own", async () => {
    const { folders, image, packages, state } = await started();
    const first = image(app("weather", "sanctum.weather", "0.3.0", "first"));
    const second = image(app("weather", "sanctum.weather", "0.3.0", "second"));

    await packages.stage(first);
    const { current: before } = (await state()).apps["sanctum.weather"]!;
    await packages.stage(second);

    const { current, previous } = (await state()).apps["sanctum.weather"]!;
    expect(current.folder).not.toBe(before.folder);
    expect(current.version).toBe("0.3.0");
    expect(previous).toEqual(before);
    expect(await folders("sanctum.weather")).toEqual(
      [before.folder, current.folder].sort(),
    );
  });

  it("keeps the version before and drops the one before that", async () => {
    const { folders, image, packages, state } = await started();
    for (const version of ["0.3.0", "0.4.0", "0.5.0"]) {
      await packages.stage(image(app("weather", "sanctum.weather", version)));
    }

    const { current, previous } = (await state()).apps["sanctum.weather"]!;
    expect(current.version).toBe("0.5.0");
    expect(previous?.version).toBe("0.4.0");
    expect(await folders("sanctum.weather")).toEqual(
      [previous!.folder, current.folder].sort(),
    );
  });

  it("leaves an app an update doesn't change with the one folder", async () => {
    const { folders, image, packages, state } = await started();
    const moods = app("moods", "sanctum.moods", "0.2.0");
    await packages.stage(
      image({ ...moods, ...app("weather", "sanctum.weather", "0.3.0") }),
    );
    const before = (await state()).apps["sanctum.moods"]!;

    await packages.stage(
      image({ ...moods, ...app("weather", "sanctum.weather", "0.4.0") }),
    );

    expect((await state()).apps["sanctum.moods"]).toEqual(before);
    expect(await folders("sanctum.moods")).toEqual([before.current.folder]);
    expect((await state()).apps["sanctum.weather"]!.previous?.version).toBe(
      "0.3.0",
    );
  });

  it("swaps what it kept when an image brings the version before back", async () => {
    const { folders, image, packages, state } = await started();
    const older = app("weather", "sanctum.weather", "0.3.0");
    await packages.stage(image(older));
    await packages.stage(image(app("weather", "sanctum.weather", "0.4.0")));

    await packages.stage(image(older));

    const { current, previous } = (await state()).apps["sanctum.weather"]!;
    expect(current.version).toBe("0.3.0");
    expect(previous?.version).toBe("0.4.0");
    expect(await folders("sanctum.weather")).toHaveLength(2);
  });

  it("stages again when a folder it noted has gone", async () => {
    const { folders, image, packages, root, state } = await started();
    const core = image(app("weather", "sanctum.weather", "0.3.0"));
    await packages.stage(core);
    const { current } = (await state()).apps["sanctum.weather"]!;
    await rm(join(root, "sanctum.weather", current.folder), {
      recursive: true,
    });

    await packages.stage(core);

    expect(await folders("sanctum.weather")).toEqual([current.folder]);
  });

  it("doesn't go looking for the version before, which no image can bring back", async () => {
    const { created, image, packages, root, state } = await started();
    await packages.stage(image(app("weather", "sanctum.weather", "0.3.0")));
    const core = image(app("weather", "sanctum.weather", "0.4.0"));
    await packages.stage(core);
    const { previous } = (await state()).apps["sanctum.weather"]!;
    await rm(join(root, "sanctum.weather", previous!.folder), {
      recursive: true,
    });
    const before = created();

    await packages.stage(core);

    expect(created()).toBe(before);
  });

  it("notes an image that ships none, as a development stack's", async () => {
    const { created, docker, image, log, packages, state } = await started();
    const core = image();

    await packages.stage(core);
    await packages.stage(core);

    expect(await state()).toEqual({ image: core, apps: {} });
    expect(created()).toBe(1);
    expect(docker.container(reader)).toBeUndefined();
    expect(docker.container(writer)).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it("puts a package in place only once it's whole and on the disk", async () => {
    const { dataDir, folders, image, packages, root, state } = await started();
    const seen: Array<{ path: string; placed: string[]; noted: boolean }> = [];
    durable.onFileSystemSync = async (path) => {
      seen.push({
        path,
        placed: await folders("sanctum.weather"),
        noted: await readFile(join(dataDir, "packages.json")).then(
          () => true,
          () => false,
        ),
      });
    };

    await packages.stage(image(app("weather", "sanctum.weather", "0.3.0")));

    expect(seen).toEqual([
      { path: join(root, ".staging"), placed: [], noted: false },
    ]);
    expect(await folders("sanctum.weather")).toEqual([
      (await state()).apps["sanctum.weather"]!.current.folder,
    ]);
  });

  describe("when it can't", () => {
    it("says so, keeps what it had and leaves nothing behind", async () => {
      const { docker, image, log, packages, root, state } = await started();
      const first = image(app("weather", "sanctum.weather", "0.3.0"));
      await packages.stage(first);
      const before = await state();
      docker.getArchiveError = new Error("Docker went away");

      await expect(
        packages.stage(image(app("weather", "sanctum.weather", "0.4.0"))),
      ).resolves.toBeUndefined();

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Docker went away"),
      );
      expect(await state()).toEqual(before);
      expect(await readdir(root)).toEqual(["sanctum.weather"]);
      expect(docker.container(reader)).toBeUndefined();
      expect(docker.container(writer)).toBeUndefined();
    });

    it("removes what it made when Docker can't make the next one", async () => {
      const { docker, image, log, packages } = await started();
      const core = image(app("weather", "sanctum.weather", "0.3.0"));
      const create = docker.createContainer.bind(docker);
      docker.createContainer = async (options) => {
        if (options.name === writer) throw new Error("Docker is busy");
        return create(options);
      };

      await packages.stage(core);

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Docker is busy"),
      );
      expect(docker.container(reader)).toBeUndefined();
    });

    it("leaves a container that takes a helper's name during creation alone", async () => {
      const { docker, image, packages } = await started();
      const core = image(app("weather", "sanctum.weather", "0.3.0"));
      const create = docker.createContainer.bind(docker);
      docker.createContainer = async (options) => {
        if (options.name === writer) {
          docker.run({ name: writer, Image: core });
        }
        return create(options);
      };

      await packages.stage(core);

      expect(docker.container(writer)).toBeDefined();
      expect(docker.container(reader)).toBeUndefined();
    });

    it("releases the reader after an early write failure and tries again next time", async () => {
      const { docker, image, packages, state } = await started();
      const core = image(app("weather", "sanctum.weather", "0.3.0"));
      docker.putArchiveError = new Error("No space left on device");
      await packages.stage(core);

      expect(docker.container(reader)).toBeUndefined();
      expect(docker.container(writer)).toBeUndefined();
      await packages.stage(core);

      expect((await state()).image).toBe(core);
    });

    it("keeps going after a failure, for whoever stages next", async () => {
      const { docker, image, packages, state } = await started();
      docker.getArchiveError = new Error("Docker went away");
      const failing = packages.stage(
        image(app("weather", "sanctum.weather", "0.3.0")),
      );
      await failing;
      docker.getArchiveError = null;
      const core = image(app("weather", "sanctum.weather", "0.4.0"));

      await packages.stage(core);

      expect((await state()).image).toBe(core);
    });

    it("clears packages left by a failed attempt before unpacking again", async () => {
      const { docker, folders, image, packages, state } = await started();
      await packages.stage(image(app("weather", "sanctum.weather", "0.3.0")));
      const before = await state();
      await packages.stage(
        image({
          ...app("a-weather", "sanctum.weather", "0.4.0"),
          ...app("z-broken", "sanctum.broken", "invalid"),
        }),
      );
      expect(await state()).toEqual(before);
      const create = docker.createContainer.bind(docker);
      let beforeCopy: string[] | undefined;
      docker.createContainer = async (options) => {
        if (options.name === reader) {
          beforeCopy = await folders("sanctum.weather");
        }
        return create(options);
      };
      docker.putArchiveError = new Error("No space left on device");

      await packages.stage(image(app("weather", "sanctum.weather", "0.4.0")));

      const kept = [before.apps["sanctum.weather"]!.current.folder];
      expect(beforeCopy).toEqual(kept);
      expect(await folders("sanctum.weather")).toEqual(kept);
      expect(await state()).toEqual(before);
    });

    it.each([
      ["an id that climbs out of its folder", "..", "0.3.0"],
      ["an id with a slash in it", "sanctum/../../etc", "0.3.0"],
      ["a version that climbs out of its folder", "sanctum.weather", "../0"],
      ["build metadata with a slash", "sanctum.weather", "0.3.0+../other"],
    ])("refuses %s", async (_case, id, version) => {
      const { dataDir, image, log, packages, root } = await started();

      await packages.stage(image(app("weather", id, version)));

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("no usable sanctum-app.json"),
      );
      expect(await readdir(root)).toEqual([]);
      await expect(
        readFile(join(dataDir, "packages.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses a folder with no manifest", async () => {
      const { image, log, packages } = await started();

      await packages.stage(image({ "weather/dist/index.js": "code" }));

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("no usable sanctum-app.json"),
      );
    });
  });

  describe("after a crash", () => {
    it("finishes cleanup after noting the image, without unpacking it again", async () => {
      const {
        created,
        dataDir,
        docker,
        folders,
        image,
        log,
        packages,
        root,
        state,
      } = await started();
      const core = image(app("weather", "sanctum.weather", "0.3.0"));
      await packages.stage(core);
      const before = await state();
      const { current } = before.apps["sanctum.weather"]!;
      // The record reached the disk, but pruning and removing staging didn't.
      await mkdir(join(root, "sanctum.weather/0.1.0+stale"));
      await mkdir(join(root, "sanctum.gone/0.1.0+stale"), { recursive: true });
      await mkdir(join(root, ".staging/weather"), { recursive: true });

      await createPackages({ docker, dataDir, log }).stage(core);

      expect(await state()).toEqual(before);
      expect(await folders("sanctum.weather")).toEqual([current.folder]);
      expect(await readdir(root)).toEqual(["sanctum.weather"]);
      expect(created()).toBe(1);
    });

    it("clears a half-unpacked copy and the containers doing it", async () => {
      const { docker, image, packages, root, state } = await started();
      await mkdir(join(root, ".staging/half"), { recursive: true });
      await writeFile(join(root, ".staging/half/file"), "half");
      docker.load("left-behind", { title: "sanctum-core", version: "0" });
      for (const name of [reader, writer]) {
        docker.run({
          name,
          Image: "left-behind",
          Labels: {
            "sanctum.managed": "true",
            "sanctum.role": "packages-copy",
          },
        });
      }
      const core = image(app("weather", "sanctum.weather", "0.3.0"));

      await packages.stage(core);

      expect((await state()).apps["sanctum.weather"]).toBeDefined();
      expect(await readdir(root)).toEqual(["sanctum.weather"]);
    });

    it("refuses a container of that name that isn't its own", async () => {
      const { docker, image, log, packages } = await started();
      docker.load("by-hand", { title: "something", version: "0" });
      docker.run({ name: writer, Image: "by-hand" });

      await packages.stage(image(app("weather", "sanctum.weather", "0.3.0")));

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Refusing to manage"),
      );
      expect(docker.container(writer)).toBeDefined();
    });

    it("replaces an unrecorded package and clears what's stale", async () => {
      const { dataDir, folders, image, packages, root, state } =
        await started();
      const core = image(app("weather", "sanctum.weather", "0.3.0"));
      await packages.stage(core);
      const { current } = (await state()).apps["sanctum.weather"]!;
      // As if the power went between the rename and the note.
      await rm(join(dataDir, "packages.json"));
      await mkdir(join(root, "sanctum.weather", "0.1.0+stale"));
      await mkdir(join(root, "sanctum.gone", "0.1.0+stale"), {
        recursive: true,
      });

      await packages.stage(core);

      expect((await state()).apps["sanctum.weather"]).toEqual({ current });
      expect(await folders("sanctum.weather")).toEqual([current.folder]);
      expect(await readdir(root)).toEqual(["sanctum.weather"]);
    });
  });

  it("stages one image at a time, the last one last", async () => {
    const { image, log, packages, state } = await started();
    const first = image(app("weather", "sanctum.weather", "0.3.0"));
    const second = image(app("weather", "sanctum.weather", "0.4.0"));

    await Promise.all([packages.stage(first), packages.stage(second)]);

    expect(log.mock.calls.flat().join()).not.toContain("Could not");
    const { apps, image: from } = await state();
    expect(from).toBe(second);
    expect(apps["sanctum.weather"]!.current.version).toBe("0.4.0");
    expect(apps["sanctum.weather"]!.previous?.version).toBe("0.3.0");
  });
});

describe("clearing versions nothing can go back to", () => {
  async function twoVersions() {
    const context = await started();
    await context.packages.stage(
      context.image({
        ...app("weather", "sanctum.weather", "0.3.0"),
        ...app("moods", "sanctum.moods", "0.2.0"),
      }),
    );
    await context.packages.stage(
      context.image({
        ...app("weather", "sanctum.weather", "0.4.0"),
        ...app("moods", "sanctum.moods", "0.3.0"),
      }),
    );
    return context;
  }

  it("clears the version before of an app that has never run apart", async () => {
    const { folders, packages, state } = await twoVersions();
    const canGoBack = async (id: string) => id === "sanctum.moods";

    await expect(packages.clearable(canGoBack)).resolves.toMatchObject({
      folders: 1,
      bytes: expect.any(Number),
    });
    await packages.clear(canGoBack);

    const { apps } = await state();
    expect(apps["sanctum.weather"]!.previous).toBeUndefined();
    expect(await folders("sanctum.weather")).toEqual([
      apps["sanctum.weather"]!.current.folder,
    ]);
    expect(apps["sanctum.moods"]!.previous).toBeDefined();
    expect(await folders("sanctum.moods")).toHaveLength(2);
    await expect(packages.clearable(canGoBack)).resolves.toEqual({
      folders: 0,
      bytes: 0,
    });
  });

  it("clears nothing when every app could go back", async () => {
    const { packages, state } = await twoVersions();
    const before = await state();

    await packages.clear(async () => true);

    expect(await state()).toEqual(before);
  });
});

describe("what names a package", () => {
  async function tree() {
    const root = await mkdtemp(join(tmpdir(), "sanctum-digest-"));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist/index.js"), "code");
    await writeFile(join(root, "run.sh"), "#!/bin/sh");
    await symlink("dist/index.js", join(root, "link"));
    return root;
  }

  it("comes out the same for the same files, whenever they were made", async () => {
    const one = await tree();
    const other = await tree();
    await utimes(join(other, "dist/index.js"), 1, 1);

    expect(await digestOf(other)).toBe(await digestOf(one));
  });

  it.each([
    [
      "a file's contents",
      (root: string) => writeFile(join(root, "dist/index.js"), "other"),
    ],
    [
      "a file's permissions",
      (root: string) => chmod(join(root, "run.sh"), 0o755),
    ],
    [
      "a file's name",
      (root: string) => rename(join(root, "run.sh"), join(root, "go.sh")),
    ],
    ["a new folder", (root: string) => mkdir(join(root, "empty"))],
    [
      "where a link points",
      async (root: string) => {
        await rm(join(root, "link"));
        await symlink("run.sh", join(root, "link"));
      },
    ],
  ])("changes with %s", async (_case, change) => {
    const root = await tree();
    const before = await digestOf(root);

    await change(root);

    expect(await digestOf(root)).not.toBe(before);
  });
});

describe("what's staged for an image", () => {
  it("stages it first if it hasn't been, as when a core asks before its commit arrives", async () => {
    const { image, packages } = await started();
    const core = image(app("weather", "sanctum.weather", "0.3.0", "weather"));

    const apps = await packages.stagedFor(core);

    expect(apps["sanctum.weather"]?.current).toMatchObject({
      version: "0.3.0",
      folder: expect.stringMatching(/^0\.3\.0\+/),
    });
  });

  it("answers concurrent requests from their own image, in the order asked", async () => {
    const { image, packages, state } = await started();
    const first = image(app("weather", "sanctum.weather", "0.3.0"));
    const second = image(app("weather", "sanctum.weather", "0.4.0"));

    const [before, after] = await Promise.all([
      packages.stagedFor(first),
      packages.stagedFor(second),
    ]);

    expect(before["sanctum.weather"]?.current.version).toBe("0.3.0");
    expect(after["sanctum.weather"]?.current.version).toBe("0.4.0");
    expect((await state()).image).toBe(second);
  });

  it("does not replace a later staging request with an earlier lookup", async () => {
    const { image, packages, state } = await started();
    const first = image(app("weather", "sanctum.weather", "0.3.0"));
    const second = image(app("weather", "sanctum.weather", "0.4.0"));

    const lookup = packages.stagedFor(first);
    await packages.stage(second);
    await lookup;

    expect((await state()).image).toBe(second);
  });

  it("returns no packages if a missing folder could not be staged again", async () => {
    const { image, packages, root, state } = await started();
    const core = image(app("weather", "sanctum.weather", "0.3.0"));
    await packages.stage(core);
    const folder = (await state()).apps["sanctum.weather"]!.current.folder;
    await rm(join(root, "sanctum.weather", folder), { recursive: true });
    durable.onFileSystemSync = async () => {
      throw new Error("The disk is full");
    };

    expect(await packages.stagedFor(core)).toEqual({});
  });
});
