import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Apps' data on real images in a real stack: e2fsck, loop devices, a full image
// and SQLite, none of which a fake can stand in for.

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "../../..");
const stack = `test-images-${randomBytes(3).toString("hex")}`;
const manager = `sanctum-${stack}-manager`;
const dataVolume = `sanctum-${stack}-manager-data`;
const folder = "1.0.0+abcdef";
const image = (app: string) => `/data/images/${app}.img`;
const container = (app: string) => `sanctum-${stack}-app-${app}`;

async function run(command: string, args: string[], env: object = {}) {
  const { stdout } = await execFile(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

const docker = (...args: string[]) => run("docker", args);

async function waitFor<T>(what: string, check: () => Promise<T | undefined>) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const found = await check().catch(() => undefined);
    if (found !== undefined) return found;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function api(method: string, path: string, body?: unknown) {
  const out = await docker(
    "exec",
    manager,
    "node",
    "-e",
    `const http = require("node:http");
     const body = ${JSON.stringify(body === undefined ? "" : JSON.stringify(body))};
     const request = http.request(
       { socketPath: "/run/sanctum/manager.sock", path: ${JSON.stringify(path)}, method: ${JSON.stringify(method)},
         headers: body ? { "content-type": "application/json" } : {} },
       (response) => {
         let text = "";
         response.on("data", (chunk) => (text += chunk));
         response.on("end", () => console.log(JSON.stringify({ status: response.statusCode, text })));
       },
     );
     request.end(body);`,
  );
  const { status, text } = JSON.parse(out) as { status: number; text: string };
  return { status, body: (text ? JSON.parse(text) : null) as never };
}

const inManager = (...args: string[]) => docker("exec", manager, ...args);

// As a reboot leaves it: nothing attached.
async function detach(app: string) {
  const script = `losetup -j /sanctum-data/images/${app}.img -n -O NAME | xargs -r losetup -d`;
  const own = await docker("inspect", "-f", "{{.Image}}", manager);
  await docker(
    "run",
    "--rm",
    "--privileged",
    "-v",
    `${dataVolume}:/sanctum-data`,
    own,
    "sh",
    "-c",
    script,
  );
}

async function stage(app: string, runner: string) {
  const path = `/data/packages/${app}/${folder}`;
  const dist = `${path}/node_modules/@meetsanctum/app-sdk/dist`;
  await new Promise<void>((done, fail) => {
    const child = execFileCallback(
      "docker",
      [
        "exec",
        "-i",
        manager,
        "sh",
        "-c",
        `mkdir -p ${dist} && echo '{}' > ${path}/package.json && cat > ${dist}/runner.js`,
      ],
      (error) => (error ? fail(error) : done()),
    );
    child.stdin?.end(runner);
  });
}

// Keeps a database in its image and says how many times it has started.
const database = `
  const { DatabaseSync } = require("node:sqlite");
  const fs = require("node:fs");
  const db = new DatabaseSync("/data/app.db");
  fs.writeFileSync("/data/app.db.partial", "another app file");
  db.exec("pragma journal_mode = wal");
  db.exec("create table if not exists starts (at text)");
  db.prepare("insert into starts values (?)").run(new Date().toISOString());
  const count = db.prepare("select count(*) c from starts").get().c;
  console.log(JSON.stringify({
    starts: count,
    uid: process.getuid(),
    files: fs.readdirSync("/data").sort(),
    canReadLostFound: (() => { try { fs.readdirSync("/data/lost+found"); return true; } catch { return false; } })(),
  }));
  setInterval(() => {}, 1000);
`;

// Fills its image, and says what it was told.
const filling = `
  const fs = require("node:fs");
  let written = 0;
  let code = null;
  try {
    const block = Buffer.alloc(1024 * 1024, 7);
    for (;;) { fs.appendFileSync("/data/fill", block); written += 1; }
  } catch (error) { code = error.code; }
  console.log(JSON.stringify({ written, code }));
  setInterval(() => {}, 1000);
`;

const readReport = async (app: string) =>
  (await docker("logs", container(app)))
    .split("\n")
    .find((line) => line.startsWith("{"));

const report = async (app: string, starts?: number) =>
  JSON.parse(
    await waitFor(`${app}'s report`, async () => {
      const text = await readReport(app);
      if (!text) return;
      const parsed = JSON.parse(text) as { starts?: number };
      return starts === undefined || parsed.starts === starts
        ? text
        : undefined;
    }),
  ) as Record<string, unknown>;

// Its report, or as soon as it has stopped without one, why.
async function reportOrWhy(app: string, withinMs: number) {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const text = await readReport(app).catch(() => undefined);
    if (text) return JSON.parse(text) as Record<string, number | string>;
    const { body } = await api("GET", `/api/apps/${app}/container`);
    if ((body as { state: string }).state !== "running") {
      throw new Error(`${app} stopped: ${JSON.stringify(body)}`);
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${app} was still writing after ${withinMs} ms`);
}

const start = (app: string, dataMb = 64) =>
  api("PUT", `/api/apps/${app}/container`, {
    folder,
    memoryMb: 64,
    dataMb,
  });

describe("apps' images on real Docker", () => {
  beforeAll(async () => {
    await run("pnpm", [
      "turbo",
      "run",
      "build",
      "--ui=stream",
      "--output-logs=errors-only",
      "--filter=@meetsanctum/core...",
      "--filter=@meetsanctum/manager...",
      "--filter=./catalog/apps/*",
    ]);
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    await new Promise((done) => server.close(done));
    await run("bash", ["deploy/dev/stack.sh", "up"], {
      SANCTUM_STACK: stack,
      SANCTUM_STACK_PORT: String(port),
    });
    // The stack stages and starts its own apps first, and staging drops any
    // folder it hasn't noted, as the test's are.
    await waitFor("the stack's own apps", async () => {
      const running = await docker(
        "ps",
        "--filter",
        `label=sanctum.stack=${stack}`,
        "--filter",
        "label=sanctum.app=sanctum.fake-lights",
        "--format",
        "{{.Names}}",
      );
      return running || undefined;
    });
    await stage("test.keeper", database);
    await stage("test.blocker", database);
    await stage("test.recovery", database);
    await stage("test.broken", database);
    await stage("test.swapped", database);
    await stage("test.grow-swapped", database);
    await stage("test.gone", database);
    await stage("test.filler", filling);
    await stage("test.large", filling);
  }, 600_000);

  afterAll(async () => {
    for (const app of [
      "test.keeper",
      "test.blocker",
      "test.recovery",
      "test.broken",
      "test.swapped",
      "test.grow-swapped",
      "test.gone",
      "test.filler",
      "test.large",
    ]) {
      await docker("rm", "-f", container(app)).catch(() => undefined);
      await detach(app).catch(() => undefined);
    }
    await run("bash", ["deploy/dev/stack.sh", "down"], {
      SANCTUM_STACK: stack,
    }).catch(() => undefined);
  }, 180_000);

  it("makes an image the first time, which takes little of the disk", async () => {
    expect(await start("test.keeper")).toMatchObject({
      status: 200,
      body: { state: "running" },
    });

    expect(await report("test.keeper", 1)).toMatchObject({
      starts: 1,
      uid: 1000,
      canReadLostFound: false,
    });
    const { body } = await api("GET", "/api/apps/images");
    // Beside the images of the stack's own apps.
    const record = (
      body as { images: Array<{ app: string; bytes: number }> }
    ).images.find(({ app }) => app === "test.keeper");
    expect(record).toMatchObject({
      app: "test.keeper",
      state: "ok",
      sizeMb: 64,
    });
    expect(record!.bytes).toBeLessThan(16 * 1024 * 1024);
  });

  it("keeps an app's data through a restart", async () => {
    await start("test.keeper");

    expect(await report("test.keeper", 2)).toMatchObject({ starts: 2 });
  });

  it("checks and attaches it again as a boot leaves it, data and all", async () => {
    await api("POST", "/api/apps/test.keeper/container/stop");
    const node = await docker(
      "inspect",
      "-f",
      "{{.Image}}",
      container("test.keeper"),
    );
    await docker(
      "create",
      "--name",
      `sanctum-${stack}-app-maintenance-test.keeper`,
      "--label",
      "sanctum.managed=true",
      "--label",
      "sanctum.role=app-maintenance",
      "--label",
      `sanctum.stack=${stack}`,
      "--mount",
      `type=volume,source=sanctum-${stack}-app-data-test.keeper,target=/data`,
      node,
    );
    await detach("test.keeper");
    // Its retained, stopped container still references the volume. Another
    // app takes its old loop number before it comes back, as after a reboot.
    expect((await start("test.blocker")).status).toBe(200);
    await report("test.blocker", 1);
    await api("POST", "/api/apps/test.blocker/container/stop");

    expect((await start("test.keeper")).status).toBe(200);

    expect(await report("test.keeper", 3)).toMatchObject({ starts: 3 });
  });

  it("copies its database while it runs, and exports a file", async () => {
    expect(
      await api("POST", "/api/apps/test.keeper/maintenance", {
        operation: "export",
        file: "app.db.partial",
        name: "before.db.partial",
      }),
    ).toMatchObject({ status: 200 });
    const copied = await api("POST", "/api/apps/test.keeper/maintenance", {
      operation: "copy",
      file: "app.db",
      name: "before.db",
    });
    expect(copied).toMatchObject({
      status: 200,
      body: { bytes: expect.any(Number) },
    });
    expect(await inManager("ls", "/data/app-copies/test.keeper")).toContain(
      "before.db",
    );
    expect(
      await inManager("cat", "/data/app-copies/test.keeper/before.db.partial"),
    ).toBe("another app file");

    const exported = await api("POST", "/api/apps/test.keeper/maintenance", {
      operation: "export",
      file: "app.db",
      name: "exported.db",
    });
    expect(exported.status).toBe(200);
    for (const operation of ["copy", "export"]) {
      const missing = await api("POST", "/api/apps/test.keeper/maintenance", {
        operation,
        file: "no-such-file",
        name: "x",
      });
      expect(missing.status).toBe(404);
    }
  });

  it("clears what a run cut short left behind, and leaves nothing of its own", async () => {
    const node = await docker(
      "inspect",
      "-f",
      "{{.Image}}",
      container("test.keeper"),
    );
    const inItsData = (script: string) =>
      docker(
        "run",
        "--rm",
        "--mount",
        `type=volume,source=sanctum-${stack}-app-data-test.keeper,target=/data`,
        node,
        "sh",
        "-c",
        script,
      );
    const copies = "/data/app-copies/test.keeper";
    // As a power cut leaves them: part of a copy going back, and part of one being made.
    await inItsData("echo part > /data/.maintenance-from-a-cut");
    await inManager(
      "sh",
      "-c",
      `echo part > ${copies}/.maintenance-from-a-cut && echo part > ${copies}/.maintenance-from-a-cut-wal`,
    );

    const copied = await api("POST", "/api/apps/test.keeper/maintenance", {
      operation: "copy",
      file: "app.db",
      name: "after-a-cut.db",
    });

    expect(copied.status).toBe(200);
    expect(await inManager("ls", "-A", copies)).not.toContain(".maintenance-");
    expect(await inItsData("ls -A /data")).not.toContain(".maintenance-");
    expect(await inItsData("ls -A /data")).toContain("app.db");
  });

  it("won't put a copy back while it runs, then does, leaving no stale WAL", async () => {
    const running = await api("POST", "/api/apps/test.keeper/maintenance", {
      operation: "restore",
      file: "app.db",
      name: "before.db",
    });
    expect(running.status).toBe(409);
    await start("test.keeper");
    await report("test.keeper", 4);
    await api("POST", "/api/apps/test.keeper/container/stop");

    const restored = await api("POST", "/api/apps/test.keeper/maintenance", {
      operation: "restore",
      file: "app.db",
      name: "before.db",
    });
    expect(restored.status).toBe(200);
    expect(
      await api("POST", "/api/apps/test.keeper/maintenance", {
        operation: "export",
        file: "app.db.partial",
        name: "preserved.txt",
      }),
    ).toMatchObject({ status: 200 });
    expect(
      await inManager("cat", "/data/app-copies/test.keeper/preserved.txt"),
    ).toBe("another app file");

    await start("test.keeper");
    // The copy held three starts; this is the fourth since it was taken.
    const after = await report("test.keeper", 4);
    expect(after.files).toEqual(
      expect.arrayContaining(["app.db", "lost+found"]),
    );
  });

  it("stops an app whose image has gone, rather than give it an empty folder", async () => {
    await start("test.gone");
    await report("test.gone", 1);
    await api("POST", "/api/apps/test.gone/container/stop");
    await docker("rm", "-f", container("test.gone"));
    await detach("test.gone");
    await inManager("mv", image("test.gone"), `${image("test.gone")}.away`);

    const refused = await start("test.gone");

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: "test.gone's data is missing",
    });
    expect((await api("GET", "/api/host/status")).body).toMatchObject({
      storage: {
        images: expect.arrayContaining([
          expect.objectContaining({ app: "test.gone", state: "missing" }),
        ]),
      },
    });

    await inManager("mv", `${image("test.gone")}.away`, image("test.gone"));
    await start("test.gone");
    expect(await report("test.gone", 2)).toMatchObject({ starts: 2 });
  });

  it("sets a damaged image aside and stops the app", async () => {
    await start("test.broken");
    await report("test.broken", 1);
    await api("POST", "/api/apps/test.broken/container/stop");
    await docker("rm", "-f", container("test.broken"));
    await detach("test.broken");
    await inManager(
      "dd",
      "if=/dev/zero",
      `of=${image("test.broken")}`,
      "bs=1M",
      "count=2",
      "conv=notrunc",
    );

    const refused = await start("test.broken");

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: "test.broken's data is damaged",
    });
    expect(await inManager("ls", "/data/images")).toMatch(
      /test\.broken\.damaged-/,
    );
    const again = await start("test.broken");
    expect(again.status).toBe(409);
  });

  it("won't take another image for the one recorded", async () => {
    await start("test.swapped");
    await report("test.swapped", 1);
    await api("POST", "/api/apps/test.swapped/container/stop");
    await docker("rm", "-f", container("test.swapped"));
    await detach("test.swapped");
    await inManager(
      "mkfs.ext4",
      "-F",
      "-q",
      "-b",
      "4096",
      image("test.swapped"),
    );

    const refused = await start("test.swapped");

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: "test.swapped's data is damaged",
    });
  });

  it("writes far more than its memory limit, held only by its image", async () => {
    // Without a sync mount, the kernel kills it for what's only cache.
    expect((await start("test.large", 256)).status).toBe(200);

    const report = await reportOrWhy("test.large", 240_000);

    expect(report.code).toBe("ENOSPC");
    expect(report.written).toBeGreaterThan(190);
  }, 300_000);

  it("holds an app to its image, and growing it gives room again", async () => {
    expect((await start("test.filler")).status).toBe(200);
    const full = await reportOrWhy("test.filler", 120_000);
    expect(full.code).toBe("ENOSPC");
    // 10% kept for root, and the filesystem's own overhead.
    expect(full.written).toBeLessThan(58);
    expect(full.written).toBeGreaterThan(40);
    const refused = await api("POST", "/api/apps/test.filler/image/grow", {
      dataMb: 128,
    });
    expect(refused.status).toBe(409);
    await api("POST", "/api/apps/test.filler/container/stop");
    await docker("rm", "-f", container("test.filler"));

    const grown = await api("POST", "/api/apps/test.filler/image/grow", {
      dataMb: 128,
    });
    expect(grown.status).toBe(204);

    expect((await start("test.filler")).status).toBe(200);
    const more = await reportOrWhy("test.filler", 120_000);
    expect(more.code).toBe("ENOSPC");
    expect(more.written).toBeGreaterThan(40);
  }, 300_000);

  it("leaves no helper behind", async () => {
    expect(
      await docker(
        "ps",
        "-a",
        "--filter",
        `label=sanctum.stack=${stack}`,
        "--format",
        "{{.Names}}",
      ),
    ).not.toMatch(/image-helper|maintenance/);
  });
});
