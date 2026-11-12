import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realStack } from "./real-stack.js";
import { stageTestApp } from "./test-update-app.js";

// An app's first move, for real: the host as a release whose core ran the app in its
// own process leaves it, its file in the core's data with a WAL a killed core left
// behind, then its own container with that file on its image, through the real
// maintenance container. The core's tests cover the steps and their interruptions;
// what's here is what only real files can show, such as that WAL, and a read-only
// mount.

const app = "test.updater";
const folderOf = (version: string) => `${version}+test`;
const running: string[] = [];
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
  turnBack,
  waitFor,
} = realStack("test-moving", running);

let port: number;
let token: string;
let sourcePackage: string;

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

type Info = { id: string; state: string; version: string; run?: unknown };

const info = async () =>
  ((await call("/api/apps")).body as Info[]).find(({ id }) => id === app)!;

const until = (what: string, check: (each: Info) => boolean) =>
  waitFor(what, async () => {
    const each = await info();
    return check(each) ? each : undefined;
  });

const act = (action: string, body: object = {}) =>
  call(`/api/apps/${app}/actions/updater.${action}`, body);
const notes = async () => (await act("read")).body as string[];
const write = async (text: string) =>
  expect((await act("write", { text })).status).toBe(200);

const journal = async () =>
  (
    (await api("GET", "/api/apps/updates")).body as {
      updates: Record<string, unknown>;
    }
  ).updates;

const coreIsUp = () =>
  waitFor("the core", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok ? true : undefined;
  });

// What's in the core's data for it, read without the core.
const inTheCoreData = (script: string) =>
  docker(
    "run",
    "--rm",
    "--volume",
    `${name("core-data")}:/core-data:ro`,
    "--entrypoint",
    "sh",
    `${name("manager")}:real`,
    "-c",
    script,
  );
const originalFiles = async () =>
  (await inTheCoreData(`ls -A /core-data/apps | grep ${app} || true`))
    .split("\n")
    .filter(Boolean);
const originalSums = () =>
  inTheCoreData(`cd /core-data/apps && sha256sum ${app}.db*`);

const copiesLeft = async () =>
  (await docker("exec", name("manager"), "ls", "-A", `/data/app-copies/${app}`))
    .split("\n")
    .filter(Boolean);

// Its package staged as the manager stages what an image ships, so nothing prunes it.
async function stage(version: string, start: string) {
  const folder = folderOf(version);
  await stageTestApp(docker, name("manager"), {
    app,
    from: sourcePackage,
    parent: app,
    folder,
    version,
    start,
  });
  await docker(
    "exec",
    name("manager"),
    "node",
    "-e",
    `const fs = require("node:fs");
     const path = "/data/packages.json";
     const state = JSON.parse(fs.readFileSync(path, "utf8"));
     state.apps[${JSON.stringify(app)}] = ${JSON.stringify({
       current: { version, folder },
     })};
     fs.writeFileSync(path, JSON.stringify(state));`,
  );
}

const apart = (version: string) => {
  running[0] = `CORE_APPS_APART=${app}@${folderOf(version)}`;
};

// As a core update brings it, and a stop without warning leaves things.
async function startAgain() {
  await startManager(coreImage, port);
  await coreIsUp();
}
const killed = () => docker("rm", "-f", name("manager"), name("core"));

const onItsOwn = (version: string) => (each: Info) =>
  each.state === "running" &&
  each.run !== undefined &&
  each.version === version;

// One more note, which a core that died just after writing it left in its WAL.
const leftInTheWal = `owner="$(stat -c %u:%g /core-data/core.db)"
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/core-data/apps/${app}.db");
    db.exec("pragma journal_mode = wal");
    db.exec("pragma wal_autocheckpoint = 0");
    db.prepare("insert into notes (text) values (?)").run("written just before moving");
    process.kill(process.pid, "SIGKILL");' || true
  chown "$owner" /core-data/apps/${app}.db*`;

describe("an app's first move, for real", () => {
  beforeAll(async () => {
    await build("apps/core/Dockerfile", coreImage);
    await build("apps/manager/Dockerfile", `${name("manager")}:real`);
    await createVolumes();
    port = await freePort();
    await startManager(coreImage, port);
    const staged = await stagedFrom(await imageId(coreImage));
    const moods = staged.apps["sanctum.moods"]!.current.folder;
    sourcePackage = `/data/packages/sanctum.moods/${moods}`;
    await stage("1.0.0", "");
    apart("1.0.0");
    await waitFor("the manager to run apps", async () => {
      const { body } = await api("GET", "/api/capabilities");
      return (body as { appContainers: boolean }).appContainers
        ? true
        : undefined;
    });
    await killed();
    await startAgain();
    token = await claim();
    await until("it to run on its own", onItsOwn("1.0.0"));
    await write("written before it moved");
    await turnBack([app], leftInTheWal);
  }, 1_800_000);

  afterAll(async () => {
    await run("bash", ["deploy/dev/stack.sh", "down"], {
      SANCTUM_STACK: stack,
    }).catch(() => undefined);
  }, 120_000);

  it("moves with all its file has, what a killed core left in its WAL too", async () => {
    expect(await originalFiles()).toContain(`${app}.db-wal`);
    const before = await originalSums();
    await startAgain();

    await until("it to run on its own", onItsOwn("1.0.0"));

    expect(await notes()).toEqual([
      "written before it moved",
      "written just before moving",
    ]);
    await write("written apart");
    expect(await originalSums()).toBe(before);
    await waitFor("the manager to let go", async () =>
      Object.keys(await journal()).length === 0 ? true : undefined,
    );
    expect(await copiesLeft()).toEqual([]);
    expect((await call(`/api/apps/${app}/go-back`)).body).toEqual({ to: null });
  }, 300_000);

  it("stays on its own when the core starts again, not on its old file", async () => {
    await killed();
    await startAgain();

    await until("it to run on its own", onItsOwn("1.0.0"));

    expect((await notes()).at(-1)).toBe("written apart");
  }, 300_000);

  it("drops its original once its next update has committed", async () => {
    await stage("2.0.0", "");
    apart("2.0.0");
    await killed();
    await startAgain();

    await until("it to update", onItsOwn("2.0.0"));
    await waitFor("its original to go", async () =>
      (await originalFiles()).length === 0 ? true : undefined,
    );

    expect((await notes()).at(-1)).toBe("written apart");
    expect((await call(`/api/apps/${app}/go-back`)).body).toMatchObject({
      to: { version: "1.0.0" },
    });
  }, 300_000);
});
