import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createPackages, type PackagesState } from "../src/update/packages.js";
import {
  createStackPackages,
  followStackBuilds,
  watchStackBuilds,
} from "../src/update/stack-packages.js";
import { FakeDocker } from "./fake-docker.js";

vi.mock("../src/durable.js", async (original) => ({
  ...(await original<typeof import("../src/durable.js")>()),
  syncFileSystem: async () => {},
}));

async function write(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

// A stack's image with each app's dependencies, and a worktree with each app's
// build and the SDK's, as deploy/dev/stack.Dockerfile and stack.sh lay them out.
async function stackOf() {
  const root = await mkdtemp(join(tmpdir(), "sanctum-stack-packages-"));
  const dependencies = join(root, "image");
  const sources = join(root, "worktree");
  const log = vi.fn();
  const files = ["dist", "migrations", "sanctum-app.json"];
  const app = async (
    folder: string,
    name: string,
    id: string,
    { code = "export default {}", built = true } = {},
  ) => {
    await write(
      join(dependencies, name, "node_modules/zod/index.js"),
      "// zod",
    );
    await write(
      join(
        dependencies,
        name,
        "node_modules/@meetsanctum/app-sdk/package.json",
      ),
      "{}",
    );
    const source = join(sources, folder, name);
    await write(join(source, "package.json"), JSON.stringify({ files }));
    await write(join(source, "src/index.ts"), "// source");
    await write(join(source, "dist/index.js"), code);
    if (built) {
      await write(
        join(source, "sanctum-app.json"),
        JSON.stringify({ id, version: "0.1.0" }),
      );
    }
  };
  await write(join(sources, "packages/app-sdk/dist/runner.js"), "// runner");
  return {
    root,
    sources,
    log,
    app,
    stackPackages: createStackPackages({ dependencies, sources, log }),
    // A new build of an app's code.
    build: (folder: string, name: string, code: string) =>
      write(join(sources, folder, name, "dist/index.js"), code),
  };
}

describe("a development stack's apps", () => {
  it("puts each app's dependencies, its build and the SDK's together", async () => {
    const { app, root, stackPackages } = await stackOf();
    await app("catalog/apps", "weather", "sanctum.weather", {
      code: "weather",
    });
    const into = join(root, "staging");

    await stackPackages.assemble(into);

    const weather = join(into, "weather");
    expect((await readdir(weather)).sort()).toEqual([
      "dist",
      "node_modules",
      "sanctum-app.json",
    ]);
    expect(await readFile(join(weather, "dist/index.js"), "utf8")).toBe(
      "weather",
    );
    expect(
      await readFile(join(weather, "node_modules/zod/index.js"), "utf8"),
    ).toBe("// zod");
    expect(
      await readFile(
        join(weather, "node_modules/@meetsanctum/app-sdk/dist/runner.js"),
        "utf8",
      ),
    ).toBe("// runner");
  });

  it("finds the stack's own apps beside the catalog's", async () => {
    const { app, root, stackPackages } = await stackOf();
    await app("catalog/apps", "weather", "sanctum.weather");
    await app("deploy/dev/apps", "fake-lights", "sanctum.fake-lights");
    const into = join(root, "staging");

    await stackPackages.assemble(into);

    expect((await readdir(into)).sort()).toEqual(["fake-lights", "weather"]);
  });

  it("assembles only those named", async () => {
    const { app, root, stackPackages } = await stackOf();
    await app("catalog/apps", "weather", "sanctum.weather");
    await app("catalog/apps", "moods", "sanctum.moods");
    const into = join(root, "staging");

    await stackPackages.assemble(into, ["moods"]);

    expect(await readdir(into)).toEqual(["moods"]);
  });

  it("leaves out an app that isn't built yet, and says so", async () => {
    const { app, log, root, stackPackages } = await stackOf();
    await app("catalog/apps", "weather", "sanctum.weather", { built: false });
    const into = join(root, "staging");
    await mkdir(into);

    await stackPackages.assemble(into);

    expect(await readdir(into)).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "weather isn't built yet, so it isn't staged",
    );
  });

  it("notices a new build of an app's code, and of the SDK for every app", async () => {
    const { app, build, sources, stackPackages } = await stackOf();
    await app("catalog/apps", "weather", "sanctum.weather");
    await app("catalog/apps", "moods", "sanctum.moods");
    const before = await stackPackages.builds();

    await build("catalog/apps", "weather", "a new build");
    const after = await stackPackages.builds();
    expect(after.get("weather")).not.toBe(before.get("weather"));
    expect(after.get("moods")).toBe(before.get("moods"));

    await write(join(sources, "packages/app-sdk/dist/runner.js"), "// newer");
    const sdk = await stackPackages.builds();
    expect(sdk.get("weather")).not.toBe(after.get("weather"));
    expect(sdk.get("moods")).not.toBe(after.get("moods"));
  });

  it("isn't changed by the app's source, only its build", async () => {
    const { app, sources, stackPackages } = await stackOf();
    await app("catalog/apps", "weather", "sanctum.weather");
    const before = await stackPackages.builds();

    await write(
      join(sources, "catalog/apps/weather/src/index.ts"),
      "// edited",
    );

    expect((await stackPackages.builds()).get("weather")).toBe(
      before.get("weather"),
    );
  });
});

describe("staging a stack's apps", () => {
  async function staged() {
    const stack = await stackOf();
    const docker = new FakeDocker();
    const dataDir = await mkdtemp(join(tmpdir(), "sanctum-packages-"));
    docker.volumeFolders.set("sanctum-manager-data", dataDir);
    // A stack's core image, which ships no packages.
    const image = docker.load("sanctum-core:dev", {
      title: "sanctum-core",
      version: "dev-stack",
    });
    // As a manager that starts, on the stack's data.
    const managing = () => {
      const stackPackages = createStackPackages({
        dependencies: join(stack.root, "image"),
        sources: stack.sources,
        log: stack.log,
      });
      const packages = createPackages({
        docker,
        dataDir,
        log: stack.log,
        worktree: stackPackages,
      });
      return { packages, stackPackages };
    };
    const { packages, stackPackages } = managing();
    const state = async () =>
      JSON.parse(
        await readFile(join(dataDir, "packages.json"), "utf8"),
      ) as PackagesState;
    return {
      ...stack,
      dataDir,
      docker,
      image,
      managing,
      packages,
      stackPackages,
      state,
    };
  }

  it("stages them from the worktree for an image that ships none", async () => {
    const { app, dataDir, image, packages, state } = await staged();
    await app("catalog/apps", "weather", "sanctum.weather", {
      code: "weather",
    });

    await packages.stage(image);

    const { apps } = await state();
    const { folder } = apps["sanctum.weather"]!.current;
    expect(folder).toMatch(/^0\.1\.0\+[0-9a-f]{16}$/);
    expect(
      await readFile(
        join(dataDir, "packages/sanctum.weather", folder, "dist/index.js"),
        "utf8",
      ),
    ).toBe("weather");
  });

  it("stages a new build as a new package, keeping the one before", async () => {
    const { app, build, image, packages, state } = await staged();
    await app("catalog/apps", "weather", "sanctum.weather");
    await app("catalog/apps", "moods", "sanctum.moods");
    await packages.stage(image);
    const before = (await state()).apps;

    await build("catalog/apps", "weather", "a new build");

    expect(await packages.restage(["weather"])).toEqual(["sanctum.weather"]);
    const after = (await state()).apps;
    expect(after["sanctum.weather"]!.current.folder).not.toBe(
      before["sanctum.weather"]!.current.folder,
    );
    expect(after["sanctum.weather"]!.previous).toEqual(
      before["sanctum.weather"]!.current,
    );
    expect(after["sanctum.moods"]).toEqual(before["sanctum.moods"]);
  });

  it("finds nothing new in a build that holds the same", async () => {
    const { app, image, packages } = await staged();
    await app("catalog/apps", "weather", "sanctum.weather");
    await packages.stage(image);

    expect(await packages.restage()).toEqual([]);
  });

  it("waits for a first staging to stage beside", async () => {
    const { app, packages } = await staged();
    await app("catalog/apps", "weather", "sanctum.weather");

    expect(await packages.restage()).toBeUndefined();
  });

  it("notes the builds it staged, and only once they are", async () => {
    const { app, image, packages, stackPackages } = await staged();
    await app("catalog/apps", "weather", "sanctum.weather");
    expect(stackPackages.staged().size).toBe(0);

    await packages.stage(image);

    expect(stackPackages.staged()).toEqual(await stackPackages.builds());
  });

  it("stages them afresh when its manager starts, for builds made while it was stopped", async () => {
    const { app, build, image, managing, packages, state } = await staged();
    await app("catalog/apps", "weather", "sanctum.weather");
    await packages.stage(image);
    const before = (await state()).apps["sanctum.weather"]!.current;

    await build("catalog/apps", "weather", "built while stopped");
    await managing().packages.stage(image);

    const after = (await state()).apps["sanctum.weather"]!;
    expect(after.current.folder).not.toBe(before.folder);
    expect(after.previous).toEqual(before);
  });

  it("then keeps what it has staged for the image", async () => {
    const { app, build, image, packages, state } = await staged();
    await app("catalog/apps", "weather", "sanctum.weather");
    await packages.stage(image);
    const before = await state();

    await build("catalog/apps", "weather", "a build the watcher stages");
    await packages.stage(image);

    expect(await state()).toEqual(before);
  });

  it("looks for packages in a stack's image once", async () => {
    const { app, docker, image, packages } = await staged();
    await app("catalog/apps", "weather", "sanctum.weather");
    await packages.stage(image);

    await packages.restage();
    await packages.restage();

    expect(
      docker.events.filter((event) =>
        event.startsWith("create sanctum-packages-reader"),
      ),
    ).toHaveLength(1);
  });
});

describe("following a stack's builds", () => {
  // Each look finds the next build in `looks`, and then the last one for good.
  const watched = (
    looks: Array<Map<string, string>>,
    staged: Map<string, string>,
  ) => {
    let last = new Map<string, string>();
    const built = vi.fn(async (_names: string[]) => {});
    const watching = watchStackBuilds({
      builds: async () => (last = looks.shift() ?? last),
      staged: () => staged,
      built,
      everyMs: 2,
    });
    return { built, watching };
  };
  const weather = (build: string) => new Map([["weather", build]]);
  const settle = () => new Promise((done) => setTimeout(done, 30));

  it("offers a build once it has stayed the same for a whole look", async () => {
    const looks = [weather("1"), weather("2"), weather("2")];
    const { built, watching } = watched(looks, weather("0"));

    await vi.waitFor(() => expect(looks).toHaveLength(0));
    await settle();
    watching.close();

    expect(built.mock.calls).toEqual([[["weather"]]]);
  });

  it("offers nothing that's staged already", async () => {
    const { built, watching } = watched([weather("1")], weather("1"));

    await settle();
    watching.close();

    expect(built).not.toHaveBeenCalled();
  });

  it("offers nothing before a first staging, which stages every app", async () => {
    const staged = new Map<string, string>();
    const { built, watching } = watched([weather("1")], staged);

    await settle();
    expect(built).not.toHaveBeenCalled();
    staged.set("weather", "0");
    await vi.waitFor(() => expect(built).toHaveBeenCalledTimes(1));
    watching.close();
  });

  it("offers a build once, so one that didn't stage waits for the next", async () => {
    const looks = [weather("1")];
    const { built, watching } = watched(looks, weather("0"));

    await vi.waitFor(() => expect(built).toHaveBeenCalledTimes(1));
    await settle();
    expect(built).toHaveBeenCalledTimes(1);
    looks.push(weather("2"));
    await vi.waitFor(() => expect(built).toHaveBeenCalledTimes(2));
    watching.close();
  });

  it("restarts the core for a new package, once nothing is under way", async () => {
    const { app, build, stackPackages } = await stackOf();
    await app("catalog/apps", "weather", "sanctum.weather");
    stackPackages.noteStaged(await stackPackages.builds());
    let busy = true;
    const restartCore = vi.fn(async () => {});
    const restage = vi.fn(async (names: string[]) => {
      stackPackages.noteStaged(await stackPackages.builds());
      return names.includes("weather") ? ["sanctum.weather"] : [];
    });
    const log = vi.fn();
    const following = followStackBuilds({
      stackPackages,
      restage,
      isBusy: async () => busy,
      restartCore,
      log,
      everyMs: 2,
    });

    await build("catalog/apps", "weather", "a new build");
    await vi.waitFor(() => expect(restage).toHaveBeenCalledWith(["weather"]));
    await new Promise((done) => setTimeout(done, 20));
    expect(restartCore).not.toHaveBeenCalled();
    busy = false;
    await vi.waitFor(() => expect(restartCore).toHaveBeenCalledTimes(1));

    await build("catalog/apps", "weather", "another build");
    await vi.waitFor(() => expect(restartCore).toHaveBeenCalledTimes(2));
    following.close();

    expect(log).toHaveBeenCalledWith(
      "Restarting the core for the new build of sanctum.weather",
    );
  });

  it("leaves the core alone when nothing staged is new", async () => {
    const { app, build, stackPackages } = await stackOf();
    await app("catalog/apps", "weather", "sanctum.weather");
    stackPackages.noteStaged(await stackPackages.builds());
    const restartCore = vi.fn(async () => {});
    const restage = vi.fn(async () => []);
    const following = followStackBuilds({
      stackPackages,
      restage,
      isBusy: async () => false,
      restartCore,
      log: vi.fn(),
      everyMs: 2,
    });

    await build("catalog/apps", "weather", "the same code, built again");
    await vi.waitFor(() => expect(restage).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 20));
    following.close();

    expect(restartCore).not.toHaveBeenCalled();
  });
});
