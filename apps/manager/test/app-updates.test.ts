import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppRefusal } from "../src/apps/refusal.js";
import { createAppUpdates } from "../src/apps/updates.js";
import { createOperations, OperationConflictError } from "../src/operations.js";

// The manager's journal of an app's update: stopping it, copying its database,
// putting that back, and holding the slot throughout.

vi.mock("../src/durable.js", async (original) => ({
  ...(await original<typeof import("../src/durable.js")>()),
  syncFileSystem: async () => {},
}));

const app = "test.app";
const request = {
  id: "update-1",
  from: { version: "1.0.0", folder: "1.0.0+aaa" },
  to: { version: "2.0.0", folder: "2.0.0+bbb" },
  file: "app.db",
};

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "sanctum-updates-"));
});

function setup(
  options: {
    hasImage?: boolean;
    hasPackage?: () => Promise<boolean>;
    run?: (request: { operation: string; name: string }) => Promise<void>;
  } = {},
) {
  const said: string[] = [];
  const start = async () => {
    const operations = createOperations();
    const updates = createAppUpdates({
      dataDir,
      operations,
      apps: {
        stop: async (id: string) => {
          said.push(`stop ${id}`);
          return { app: id, state: "stopped" };
        },
        onItsImage: (
          _id: string,
          work: (release: () => Promise<void>) => unknown,
        ) => work(async () => undefined),
      } as never,
      images: {
        has: async () => options.hasImage ?? true,
        ensure: async () => "the-volume",
      } as never,
      maintenance: {
        run: async (
          _id: string,
          _volume: string,
          each: { operation: string; name: string; file: string },
        ) => {
          said.push(`${each.operation} ${each.file} ${each.name}`);
          await options.run?.(each);
          return { bytes: 1 };
        },
      } as never,
      hasPackage: async () => (await options.hasPackage?.()) ?? true,
      log: () => undefined,
    });
    await updates.load();
    return { operations, updates };
  };
  return { said, start };
}

describe("beginning an app's update", () => {
  it("takes the slot, stops the app, then copies its database", async () => {
    const { said, start } = setup();
    const { operations, updates } = await start();

    const entry = await updates.begin(app, request);

    expect(entry).toMatchObject({ status: "ready", copied: true });
    expect(said).toEqual(["stop test.app", "copy app.db update-1.db"]);
    expect(await operations.current()).toEqual({
      kind: "app-update",
      app,
      to: "2.0.0",
    });
  });

  it("copies nothing for an app with no data yet, and has nothing to put back", async () => {
    const { said, start } = setup({ hasImage: false });
    const { updates } = await start();

    expect(await updates.begin(app, request)).toMatchObject({ copied: false });
    await updates.undo(app, request.id);

    expect(said).toEqual(["stop test.app", "stop test.app"]);
  });

  it("has nothing to copy for an image with no database yet", async () => {
    const { start } = setup({
      run: async () => {
        throw new AppRefusal("No such file", 404);
      },
    });
    const { updates } = await start();

    expect(await updates.begin(app, request)).toMatchObject({
      status: "ready",
      copied: false,
    });
  });

  it("is refused while another operation holds the slot, touching nothing", async () => {
    const { said, start } = setup();
    const { operations, updates } = await start();
    operations.heldBy(() => ({ kind: "core-update", version: "dev-2" }));

    await expect(updates.begin(app, request)).rejects.toThrow(
      OperationConflictError,
    );

    expect(said).toEqual([]);
    expect(updates.list()).toEqual({});
  });

  it("lets only one app at a time go", async () => {
    const { start } = setup();
    const { updates } = await start();
    await updates.begin(app, request);

    await expect(
      updates.begin("test.other", { ...request, id: "update-2" }),
    ).rejects.toThrow("test.app is moving to another version");
  });

  it("frees the slot if the copy fails, as nothing has changed", async () => {
    const { start } = setup({
      run: async () => {
        throw new AppRefusal("The disk is full", 500);
      },
    });
    const { operations, updates } = await start();

    await expect(updates.begin(app, request)).rejects.toThrow(
      "The disk is full",
    );

    expect(await operations.current()).toBeNull();
    expect(updates.list()).toEqual({});
  });

  it("leaves no copy behind if it gives up after making one", async () => {
    const copies = join(dataDir, "app-copies", app);
    const { start } = setup({
      run: async () => {
        await mkdir(copies, { recursive: true });
        await writeFile(join(copies, "update-1.db"), "whole");
        throw new AppRefusal("Could not copy in time", 500);
      },
    });
    const { updates } = await start();

    await expect(updates.begin(app, request)).rejects.toThrow("in time");

    expect(await readdir(copies)).toEqual([]);
  });

  it("answers as it stands when asked again, copying once", async () => {
    const { said, start } = setup();
    const { updates } = await start();
    await updates.begin(app, request);

    expect(await updates.begin(app, request)).toMatchObject({
      status: "ready",
    });

    expect(said).toEqual(["stop test.app", "copy app.db update-1.db"]);
  });

  it("carries on after a crash part way through its copy", async () => {
    const started = new Date().toISOString();
    await writeFile(
      join(dataDir, "app-updates.json"),
      JSON.stringify({
        updates: {
          [app]: {
            ...request,
            status: "copying",
            copied: false,
            startedAt: started,
          },
        },
      }),
    );
    const { said, start } = setup();
    const { operations, updates } = await start();
    // A manager that starts finds it holding the slot.
    expect(await operations.current()).toMatchObject({ app });

    const entry = await updates.begin(app, request);

    expect(entry).toMatchObject({
      status: "ready",
      copied: true,
      startedAt: started,
    });
    expect(said).toEqual(["stop test.app", "copy app.db update-1.db"]);
  });

  it("refuses another update while one for that app is settling", async () => {
    const { start } = setup();
    const { updates } = await start();
    await updates.begin(app, request);

    expect(() => updates.begin(app, { ...request, id: "update-2" })).toThrow(
      "still settling",
    );
  });
});

describe("committing an app's update", () => {
  it("frees the slot, and asked again does nothing", async () => {
    const { start } = setup();
    const { operations, updates } = await start();
    await updates.begin(app, request);

    await updates.commit(app, request.id);
    await updates.commit(app, request.id);

    expect(await operations.current()).toBeNull();
    expect(updates.list()).toEqual({});
  });

  it("keeps this update's copy and removes older ones", async () => {
    const { start } = setup();
    const { updates } = await start();
    const copies = join(dataDir, "app-copies", app);
    await mkdir(copies, { recursive: true });
    await writeFile(join(copies, "update-0.db"), "older");
    await writeFile(join(copies, "update-1.db"), "this one");
    await updates.begin(app, request);

    await updates.commit(app, request.id);

    expect(await readdir(copies)).toEqual(["update-1.db"]);
  });

  it("ignores another update's id", async () => {
    const { operations, updates } = await setup().start();
    await updates.begin(app, request);

    await updates.commit(app, "update-0");

    expect(await operations.current()).toMatchObject({ app });
  });
});

describe("undoing an app's update", () => {
  it("keeps its journal if the data image cannot be found for a restore", async () => {
    const options = { hasImage: true };
    const { operations, updates } = await setup(options).start();
    await updates.begin(app, request);
    options.hasImage = false;

    await expect(updates.undo(app, request.id)).rejects.toThrow();

    expect(updates.list()[app]?.status).toBe("undoing");
    expect(await operations.current()).toMatchObject({ app });
    options.hasImage = true;
    await updates.undo(app, request.id);
    expect(await operations.current()).toBeNull();
  });

  it("stops what runs, puts the copy back, then frees the slot", async () => {
    const { said, start } = setup();
    const { operations, updates } = await start();
    await updates.begin(app, request);
    said.length = 0;

    await updates.undo(app, request.id);

    expect(said).toEqual(["stop test.app", "restore app.db update-1.db"]);
    expect(await operations.current()).toBeNull();
  });

  it("is never done twice, since the old version may have started by then", async () => {
    const { said, start } = setup();
    const { updates } = await start();
    await updates.begin(app, request);
    await updates.undo(app, request.id);
    said.length = 0;

    await updates.undo(app, request.id);

    expect(said).toEqual([]);
  });

  it("holds the slot until the copy is back, and tries again if it can't", async () => {
    let failing = true;
    const { start } = setup({
      run: async ({ operation }) => {
        if (operation === "restore" && failing) throw new Error("Busy");
      },
    });
    const { operations, updates } = await start();
    await updates.begin(app, request);

    await expect(updates.undo(app, request.id)).rejects.toThrow("Busy");
    expect(await operations.current()).toMatchObject({ app });
    expect(updates.list()[app]?.status).toBe("undoing");

    failing = false;
    await updates.undo(app, request.id);

    expect(await operations.current()).toBeNull();
  });

  it("removes its copy once the data is back, keeping the one before it", async () => {
    let failing = true;
    const { start } = setup({
      run: async ({ operation }) => {
        if (operation === "restore" && failing) throw new Error("Busy");
      },
    });
    const { updates } = await start();
    const copies = join(dataDir, "app-copies", app);
    await mkdir(copies, { recursive: true });
    await writeFile(join(copies, "update-0.db"), "from the last commit");
    await writeFile(join(copies, "update-1.db"), "this one");
    await updates.begin(app, request);

    await expect(updates.undo(app, request.id)).rejects.toThrow("Busy");
    expect((await readdir(copies)).sort()).toEqual([
      "update-0.db",
      "update-1.db",
    ]);

    failing = false;
    await updates.undo(app, request.id);

    expect(await readdir(copies)).toEqual(["update-0.db"]);
  });
});

describe("going back from an update", () => {
  const back = {
    id: "update-2",
    from: request.to,
    to: request.from,
    file: "app.db",
    restores: "update-1",
  };
  const copies = () => join(dataDir, "app-copies", app);
  // An update that committed, its copy kept.
  const committed = async (options: Parameters<typeof setup>[0] = {}) => {
    const parts = setup(options);
    const started = await parts.start();
    await mkdir(copies(), { recursive: true });
    await writeFile(join(copies(), "update-1.db"), "as it was on 1.0.0");
    await started.updates.begin(app, request);
    await started.updates.commit(app, request.id);
    parts.said.length = 0;
    return { ...parts, ...started };
  };

  it("keeps the version before an update with its copy, safe from staging", async () => {
    const { updates } = await committed();

    expect(await updates.kept(app)).toMatchObject({
      id: "update-1",
      from: request.from,
      at: expect.any(String),
    });
    expect(updates.foldersInUse()).toContainEqual({
      app,
      folder: request.from.folder,
    });
  });

  it("isn't there without its copy or its package", async () => {
    const options = { hasPackage: async () => true };
    const { updates } = await committed(options);
    options.hasPackage = async () => false;
    expect(await updates.kept(app)).toBeNull();

    options.hasPackage = async () => true;
    await rm(join(copies(), "update-1.db"));
    expect(await updates.kept(app)).toBeNull();
  });

  it("isn't there after an update that had no database to copy", async () => {
    const { start } = setup({
      run: async () => {
        throw new AppRefusal("Not found", 404);
      },
    });
    const { updates } = await start();
    await updates.begin(app, request);

    await updates.commit(app, request.id);

    expect(await updates.kept(app)).toBeNull();
  });

  it("survives a manager starting again", async () => {
    const { start } = await committed();

    const { updates } = await start();

    expect(await updates.kept(app)).toMatchObject({ id: "update-1" });
  });

  it("copies what it's leaving, then puts the kept copy in place", async () => {
    const { operations, said, updates } = await committed();

    const entry = await updates.begin(app, back);

    expect(entry).toMatchObject({ status: "ready", copied: true });
    expect(said).toEqual([
      "stop test.app",
      "copy app.db update-2.db",
      "stop test.app",
      "restore app.db update-1.db",
    ]);
    expect(await operations.current()).toMatchObject({ app, to: "1.0.0" });
  });

  it("refuses a copy it doesn't keep, before stopping anything", async () => {
    const { said, updates } = await committed();

    expect(() => updates.begin(app, { ...back, restores: "update-0" })).toThrow(
      "no such copy",
    );

    expect(said).toEqual([]);
  });

  it("doesn't copy again after a crash once the kept copy may be in place", async () => {
    const { start, said } = await committed();
    const saved = JSON.parse(
      await readFile(join(dataDir, "app-updates.json"), "utf8"),
    ) as object;
    await writeFile(
      join(dataDir, "app-updates.json"),
      JSON.stringify({
        ...saved,
        updates: {
          [app]: {
            ...back,
            status: "placing",
            copied: true,
            startedAt: new Date().toISOString(),
          },
        },
      }),
    );
    const { updates } = await start();

    await updates.begin(app, back);

    expect(said).toEqual(["stop test.app", "restore app.db update-1.db"]);
  });

  it("leaves it in the journal to undo if the kept copy won't go in place", async () => {
    let failing = true;
    const { operations, said, updates } = await committed({
      run: async ({ operation, name }) => {
        if (operation === "restore" && name === "update-1.db" && failing) {
          throw new AppRefusal("Could not restore", 500);
        }
      },
    });

    await expect(updates.begin(app, back)).rejects.toThrow("Could not restore");

    expect(updates.list()[app]?.status).toBe("placing");
    expect(await operations.current()).toMatchObject({ app });
    failing = false;
    said.length = 0;
    await updates.undo(app, back.id);
    expect(said).toEqual(["stop test.app", "restore app.db update-2.db"]);
    expect(await updates.kept(app)).toMatchObject({ id: "update-1" });
    expect(await operations.current()).toBeNull();
  });

  it("undone, keeps the copy it came for and removes the one it made", async () => {
    const { updates } = await committed();
    await updates.begin(app, back);
    await writeFile(join(copies(), "update-2.db"), "as it was on 2.0.0");

    await updates.undo(app, back.id);

    expect(await readdir(copies())).toEqual(["update-1.db"]);
    expect(await updates.kept(app)).toMatchObject({ id: "update-1" });
  });

  it("once committed, leaves nothing to go back to, and no copies", async () => {
    const { operations, updates } = await committed();
    await updates.begin(app, back);
    await writeFile(join(copies(), "update-2.db"), "as it was on 2.0.0");

    await updates.commit(app, back.id);

    expect(await readdir(copies())).toEqual([]);
    expect(await updates.kept(app)).toBeNull();
    expect(updates.foldersInUse()).toEqual([
      { app, folder: request.from.folder },
    ]);
    expect(await operations.current()).toBeNull();
  });
});

describe("an app's first move", () => {
  const move = {
    id: "update-1",
    from: { version: "1.0.0" },
    to: { version: "1.0.0", folder: "1.0.0+bbb" },
    file: "app.db",
    moves: "test.app.db",
  };

  it("takes in its file from the core's data, copying nothing of its own", async () => {
    const { said, start } = setup();
    const { operations, updates } = await start();

    const entry = await updates.begin(app, move);

    expect(entry).toMatchObject({ status: "ready", copied: false });
    expect(said).toEqual(["stop test.app", "adopt app.db test.app.db"]);
    expect(await operations.current()).toMatchObject({ app });
  });

  it("makes its image for that, as it hasn't run apart before", async () => {
    const { said, start } = setup({ hasImage: false });
    const { updates } = await start();

    await updates.begin(app, move);

    expect(said).toContain("adopt app.db test.app.db");
  });

  it("is fine with no file to take in, as an app with no database has none", async () => {
    const { start } = setup({
      run: async () => {
        throw new AppRefusal("Not found", 404);
      },
    });
    const { updates } = await start();

    await expect(updates.begin(app, move)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("frees the slot if it can't, as its file is as it was", async () => {
    const { start } = setup({
      run: async () => {
        throw new AppRefusal("The disk is full", 500);
      },
    });
    const { operations, updates } = await start();

    await expect(updates.begin(app, move)).rejects.toThrow("The disk is full");

    expect(updates.list()).toEqual({});
    expect(await operations.current()).toBeNull();
  });

  it("takes it in again after a crash part way", async () => {
    const { said, start } = setup();
    await writeFile(
      join(dataDir, "app-updates.json"),
      JSON.stringify({
        updates: {
          [app]: {
            ...move,
            status: "copying",
            copied: false,
            startedAt: new Date().toISOString(),
          },
        },
        running: {},
      }),
    );
    const { updates } = await start();

    await updates.begin(app, move);

    expect(said).toEqual(["stop test.app", "adopt app.db test.app.db"]);
  });

  it("once committed, keeps the version it's on and nothing to go back to", async () => {
    const { operations, updates } = await (async () => {
      const { start } = setup();
      return start();
    })();
    await updates.begin(app, move);

    await updates.commit(app, move.id);

    expect(updates.foldersInUse()).toEqual([{ app, folder: move.to.folder }]);
    expect(await updates.kept(app)).toBeNull();
    expect(await operations.current()).toBeNull();
  });

  it("undone, stops what runs and puts nothing back", async () => {
    const { said, start } = setup();
    const { operations, updates } = await start();
    await updates.begin(app, move);
    said.length = 0;

    await updates.undo(app, move.id);

    expect(said).toEqual(["stop test.app"]);
    expect(updates.foldersInUse()).toEqual([]);
    expect(await operations.current()).toBeNull();
  });
});

describe("a step that takes too long", () => {
  afterEach(() => vi.useRealTimers());
  const minutes = (count: number) => count * 60_000;

  it("sets the update aside: the slot frees, and its journal and copy stay", async () => {
    const { operations, updates } = await setup().start();
    await updates.begin(app, request);
    expect(await operations.current()).toMatchObject({ app });

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + minutes(9) });
    expect(await operations.current()).toMatchObject({ app });
    vi.setSystemTime(Date.now() + minutes(2));

    expect(await operations.current()).toBeNull();
    expect(updates.list()[app]?.status).toBe("ready");
  });

  it("lets another operation go, and the update still be settled after", async () => {
    const { said, start } = setup();
    const { operations, updates } = await start();
    await updates.begin(app, request);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + minutes(11) });

    await updates.begin("test.other", { ...request, id: "update-2" });
    expect(await operations.current()).toMatchObject({ app: "test.other" });
    said.length = 0;

    await expect(updates.undo(app, request.id)).rejects.toThrow(
      OperationConflictError,
    );
    expect(said).toEqual([]);
    await updates.commit("test.other", "update-2");
    await updates.undo(app, request.id);

    expect(said).toEqual(["stop test.app", "restore app.db update-1.db"]);
    expect(updates.list()[app]).toBeUndefined();
  });

  it("waits for a core update before restoring a set-aside app", async () => {
    const { said, start } = setup();
    const { operations, updates } = await start();
    await updates.begin(app, request);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + minutes(11) });
    operations.heldBy(() => ({ kind: "core-update", version: "dev-2" }));
    said.length = 0;

    await expect(updates.undo(app, request.id)).rejects.toThrow(
      OperationConflictError,
    );
    expect(said).toEqual([]);
    expect(updates.list()[app]?.status).toBe("ready");
  });

  it("doesn't renew the limit when the same restore step is retried", async () => {
    const { operations, updates } = await setup({
      run: async ({ operation }) => {
        if (operation === "restore") throw new Error("Busy");
      },
    }).start();
    await updates.begin(app, request);
    await expect(updates.undo(app, request.id)).rejects.toThrow("Busy");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + minutes(9) });
    await expect(updates.undo(app, request.id)).rejects.toThrow("Busy");
    vi.setSystemTime(Date.now() + minutes(2));

    expect(await operations.current()).toBeNull();
    expect(updates.list()[app]?.status).toBe("undoing");
  });

  it("holds the slot again for a new step", async () => {
    let finish!: () => void;
    const restoring = new Promise<void>((done) => {
      finish = done;
    });
    const { operations, updates } = await setup({
      run: async ({ operation }) => {
        if (operation === "restore") await restoring;
      },
    }).start();
    await updates.begin(app, request);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + minutes(11) });
    expect(await operations.current()).toBeNull();

    const undoing = updates.undo(app, request.id);
    await vi.waitFor(() => expect(updates.list()[app]?.status).toBe("undoing"));

    expect(await operations.current()).toMatchObject({ app });
    finish();
    await undoing;
    expect(await operations.current()).toBeNull();
  });
});

describe("what staging must keep", () => {
  it("keeps both versions during an update", async () => {
    const { updates } = await setup().start();
    await updates.begin(app, request);

    expect(updates.foldersInUse()).toEqual([
      { app, folder: request.from.folder },
      { app, folder: request.to.folder },
    ]);
  });

  it("keeps the version it committed, and the one before for going back", async () => {
    const { updates } = await setup().start();
    await updates.begin(app, request);
    await updates.commit(app, request.id);

    expect(updates.foldersInUse()).toEqual([
      { app, folder: request.to.folder },
      { app, folder: request.from.folder },
    ]);
  });

  it("keeps the version it went back to, across a restart", async () => {
    const { start } = setup();
    const { updates } = await start();
    await updates.begin(app, request);
    await updates.undo(app, request.id);

    const { updates: restarted } = await start();

    expect(restarted.foldersInUse()).toEqual([
      { app, folder: request.from.folder },
    ]);
  });
});
