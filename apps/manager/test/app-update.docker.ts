import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realStack } from "./real-stack.js";
import { stageTestApp } from "./test-update-app.js";

// A real core updating a real app in its real container, with a real SQLite database
// copied and put back by the real maintenance container. The core's tests cover the
// steps and their interruptions; what's here is what only real processes and files
// can show. A new version arrives as a core update would bring it: the core starts
// again with another version to run, on the same data.

const app = "test.updater";
const folderOf = (version: string) => `${version}+test`;
const running = [`CORE_APPS_APART=${app}@${folderOf("1.0.0")}`];
const {
  api,
  build,
  claim,
  coreImage,
  createVolumes,
  docker,
  freePort,
  imageId,
  name,
  run,
  stack,
  stagedFrom,
  startManager,
  waitFor,
} = realStack("test-updating", running);

let port: number;
let token: string;

const stage = (from: string, version: string, start: string) =>
  stageTestApp(docker, name("manager"), {
    app,
    from,
    parent: app,
    folder: folderOf(version),
    version,
    start,
  });

const call = async (path: string, body?: object) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

type Info = { id: string; state: string; version: string };

const info = async () =>
  ((await call("/api/apps")).body as Info[]).find(({ id }) => id === app)!;

const until = (what: string, check: (each: Info) => boolean) =>
  waitFor(what, async () => {
    const each = await info();
    return check(each) ? each : undefined;
  });

const act = (action: string, body: object = {}) =>
  call(`/api/apps/${app}/actions/updater.${action}`, body);

// The core comes up again with another version to run, as its update would bring,
// staged as the manager stages what an image ships: this version and the one before.
// The version it runs now stays by being in use, however many have been staged since.
let broughtLast = "1.0.0";
let sourcePackage: string;
async function coreBrings(version: string, start: string) {
  await stage(sourcePackage, version, start);
  const ref = (each: string) => ({ version: each, folder: folderOf(each) });
  await docker(
    "exec",
    name("manager"),
    "node",
    "-e",
    `const fs = require("node:fs");
     const path = "/data/packages.json";
     const state = JSON.parse(fs.readFileSync(path, "utf8"));
     state.apps[${JSON.stringify(app)}] = ${JSON.stringify({
       current: ref(version),
       previous: ref(broughtLast),
     })};
     fs.writeFileSync(path, JSON.stringify(state));`,
  );
  broughtLast = version;
  running[0] = `CORE_APPS_APART=${app}@${folderOf(version)}`;
  await docker("rm", "-f", name("manager"), name("core"));
  await startManager(coreImage, port);
  await waitFor("the core", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok ? true : undefined;
  });
}

const journal = async () =>
  (
    (await api("GET", "/api/apps/updates")).body as {
      updates: Record<string, unknown>;
    }
  ).updates;

const notes = async () => (await act("read")).body as string[];

// All that's there, hidden files too, as what a run leaves behind is hidden.
const copiesKept = async () =>
  (await docker("exec", name("manager"), "ls", "-A", `/data/app-copies/${app}`))
    .split("\n")
    .filter(Boolean);

describe("an app's update, for real", () => {
  beforeAll(async () => {
    await build("apps/core/Dockerfile", coreImage);
    await build("apps/manager/Dockerfile", `${name("manager")}:real`);
    await createVolumes();
    port = await freePort();
    await startManager(coreImage, port);
    const staged = await stagedFrom(await imageId(coreImage));
    const moods = staged.apps["sanctum.moods"]!.current.folder;
    sourcePackage = `/data/packages/sanctum.moods/${moods}`;
    await stage(sourcePackage, "1.0.0", "");
    await waitFor("the manager to run apps", async () => {
      const { body } = await api("GET", "/api/capabilities");
      return (body as { appContainers: boolean }).appContainers
        ? true
        : undefined;
    });
    await waitFor("the core", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok ? true : undefined;
    });
    token = await claim();
    await docker("restart", name("core"));
    await until("the first version to run", ({ state }) => state === "running");
    expect(await act("write", { text: "written by 1.0.0" })).toMatchObject({
      status: 200,
    });
  }, 1_800_000);

  afterAll(async () => {
    await run("bash", ["deploy/dev/stack.sh", "down"], {
      SANCTUM_STACK: stack,
    }).catch(() => undefined);
  }, 120_000);

  it("undoes a version that writes to its data and fails, with the data as it was", async () => {
    await coreBrings(
      "2.0.0",
      `await ctx.storage.db.run(sql\`INSERT INTO notes (text) VALUES ('written by 2.0.0, which then failed')\`);
       throw new Error("2.0.0 falls over");`,
    );

    const back = await until(
      "the old version to be back",
      ({ state, version }) => state === "running" && version === "1.0.0",
    );

    expect(back.version).toBe("1.0.0");
    expect(await notes()).toEqual(["written by 1.0.0"]);
    expect(await journal()).toEqual({});
    expect((await api("GET", `/api/apps/${app}/container`)).body).toMatchObject(
      { state: "running", folder: folderOf("1.0.0") },
    );
    expect(await copiesKept()).toEqual([]);
  }, 240_000);

  it("stays there when the core starts again, not trying that version again", async () => {
    await docker("restart", name("core"));
    await waitFor("the core", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok ? true : undefined;
    });

    const back = await until("it to run", ({ state }) => state === "running");

    expect(back.version).toBe("1.0.0");
    expect(await notes()).toEqual(["written by 1.0.0"]);
  }, 240_000);

  it("goes back from one that isn't ready, with its data as it was, and frees the slot", async () => {
    await coreBrings(
      "2.5.0",
      `await ctx.storage.db.run(sql\`INSERT INTO notes (text) VALUES ('written by 2.5.0, which then waited')\`);
       throw new NotReady("Waiting for the test");`,
    );

    const back = await until(
      "the old version to be back",
      ({ state, version }) => state === "running" && version === "1.0.0",
    );

    expect(back.version).toBe("1.0.0");
    expect(await notes()).toEqual(["written by 1.0.0"]);
    expect(await journal()).toEqual({});
  }, 240_000);

  it("takes a newer version that works, keeping what it had, and frees the slot", async () => {
    await coreBrings(
      "3.0.0",
      `await ctx.storage.db.run(sql\`INSERT INTO notes (text) VALUES ('written by 3.0.0')\`);`,
    );

    const updated = await until(
      "the new version to run",
      ({ state, version }) => state === "running" && version === "3.0.0",
    );

    expect(updated.version).toBe("3.0.0");
    expect(await notes()).toEqual(["written by 1.0.0", "written by 3.0.0"]);
    await waitFor("the manager to let go", async () =>
      Object.keys(await journal()).length === 0 ? true : undefined,
    );
    expect((await api("GET", `/api/apps/${app}/container`)).body).toMatchObject(
      { state: "running", folder: folderOf("3.0.0") },
    );
  }, 240_000);

  it("keeps only this update's copy of its data, out of the app's reach", async () => {
    expect(await copiesKept()).toHaveLength(1);
    await expect(
      docker("exec", `sanctum-${stack}-app-${app}`, "ls", "/copies"),
    ).rejects.toThrow();
  }, 60_000);

  const goBackPath = `/api/apps/${app}/go-back`;

  it("goes back when someone asks, its data as it was before that update", async () => {
    await act("write", { text: "written since that update" });
    const offered = (await call(goBackPath)).body as { to: { id: string } };
    expect(offered).toMatchObject({
      to: {
        id: expect.any(String),
        version: "1.0.0",
        since: expect.any(String),
      },
    });

    expect((await call(goBackPath, { id: offered.to.id })).status).toBe(200);

    const back = await until(
      "the old version to be back",
      ({ state, version }) => state === "running" && version === "1.0.0",
    );
    expect(back.version).toBe("1.0.0");
    expect(await notes()).toEqual(["written by 1.0.0"]);
    await waitFor("the manager to let go", async () =>
      Object.keys(await journal()).length === 0 ? true : undefined,
    );
    expect((await api("GET", `/api/apps/${app}/container`)).body).toMatchObject(
      { state: "running", folder: folderOf("1.0.0") },
    );
    await waitFor("its copies to go", async () =>
      (await copiesKept()).length === 0 ? true : undefined,
    );
    expect((await call(goBackPath)).body).toEqual({ to: null });
  }, 240_000);

  it("stays there when the core starts again, though it still brings 3.0.0", async () => {
    await docker("restart", name("core"));
    await waitFor("the core", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok ? true : undefined;
    });

    const back = await until("it to run", ({ state }) => state === "running");

    expect(back.version).toBe("1.0.0");
    expect(await notes()).toEqual(["written by 1.0.0"]);
  }, 240_000);

  it("returns to the newer version if the old one won't start", async () => {
    await coreBrings(
      "4.0.0",
      `if (info.reason === "rolledBack" && info.from === "5.0.0") throw new Error("4.0.0 won't start");
       if (info.reason === "updated") await ctx.storage.db.run(sql\`INSERT INTO notes (text) VALUES ('written by 4.0.0')\`);`,
    );
    await until(
      "4.0.0 to run",
      ({ state, version }) => state === "running" && version === "4.0.0",
    );
    await coreBrings(
      "5.0.0",
      `if (info.reason === "updated") await ctx.storage.db.run(sql\`INSERT INTO notes (text) VALUES ('written by 5.0.0')\`);`,
    );
    await until(
      "5.0.0 to run",
      ({ state, version }) => state === "running" && version === "5.0.0",
    );
    await waitFor("the manager to let go", async () =>
      Object.keys(await journal()).length === 0 ? true : undefined,
    );

    const offered = (await call(goBackPath)).body as { to: { id: string } };
    expect((await call(goBackPath, { id: offered.to.id })).status).toBe(200);
    await waitFor("it to try and come back", async () => {
      const { run } = (await info()) as Info & {
        run?: { update?: { stage: string; from?: string } };
      };
      return run?.update?.stage === "wentBack" && run.update.from === "4.0.0"
        ? true
        : undefined;
    });

    const back = await until("it to run", ({ state }) => state === "running");
    expect(back.version).toBe("5.0.0");
    expect(await notes()).toEqual([
      "written by 1.0.0",
      "written by 4.0.0",
      "written by 5.0.0",
    ]);
    expect(await journal()).toEqual({});
    // What it came for stays, so it can be asked for again.
    expect((await call(goBackPath)).body).toMatchObject({
      to: { version: "4.0.0" },
    });
    expect(await copiesKept()).toHaveLength(1);
  }, 480_000);
});
