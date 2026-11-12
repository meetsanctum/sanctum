import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nodeImage } from "../src/apps/containers.js";
import type { PackagesState } from "../src/update/packages.js";
import { realStack } from "./real-stack.js";

// The real images a host runs: a manager staging the official apps from a core,
// each app then loading in a plain Node container with nothing else around it,
// as in an app's own container.

const {
  api,
  build,
  buildOnTop,
  claim,
  coreImage,
  dataVolume,
  docker,
  freePort,
  imageId,
  managerLogs,
  name,
  nextCoreImage,
  readState,
  root,
  run,
  stack,
  stagedFrom,
  startManager,
  waitFor,
  createVolumes,
  // These tests run each app's container themselves, so the core must leave them be.
} = realStack("test-packages", ["CORE_OFFICIAL_APPS_APART="]);

// What each official app's manifest says, in the worktree.
const shipped = readdirSync(join(root, "catalog/apps")).map((folder) => ({
  folder,
  ...(JSON.parse(
    readFileSync(
      join(root, "catalog/apps", folder, "sanctum-app.json"),
      "utf8",
    ),
  ) as {
    id: string;
    version: string;
    runtime: { memory: number; data: number };
    permissions: { id: string }[];
  }),
}));

// Runs in the plainest place an app's package can be: nothing mounted but it,
// an unprivileged user, no network, nothing writable.
const loadScript = `
  import { readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
  import { dirname, join, resolve } from "node:path";
  const manifest = JSON.parse(readFileSync("/package/sanctum-app.json", "utf8"));
  const { default: app } = await import("/package/dist/index.js");
  let writable = true;
  try {
    writeFileSync("/package/written", "");
  } catch {
    writable = false;
  }
  const leaving = readdirSync("/package", { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((link) => !resolve(dirname(link), readlinkSync(link)).startsWith("/package/"));
  console.log(JSON.stringify({ id: manifest.id, loaded: app.id, writable, leaving }));
`;

// The core's end of an app's socket (app-testkit's conformance.ts), in a
// container beside the app's: a Unix socket doesn't cross into the Mac's. It
// reads the repository's built files, and says what it saw as lines of JSON.
function conformancePeer(id: string, folder: string) {
  const child = spawn("docker", [
    "run",
    "--rm",
    "--label",
    `sanctum.stack=${stack}`,
    "--network",
    "none",
    "--mount",
    `type=volume,src=${dataVolume},dst=/shared`,
    "--mount",
    `type=bind,src=${root},dst=/repo,readonly`,
    nodeImage,
    "node",
    "/repo/packages/app-testkit/dist/conformance.js",
    `/shared/sockets/${id}/core.sock`,
    `/shared/packages/${id}/${folder}/sanctum-app.json`,
  ]);
  const lines: string[] = [];
  let out = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
    const parts = out.split("\n");
    out = parts.pop() ?? "";
    lines.push(...parts);
  });
  child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  const line = (index: number) =>
    waitFor(`the conformance peer's line ${index} for ${id}`, async () => {
      if (child.exitCode !== null && lines.length <= index) {
        throw new Error(`It exited with ${child.exitCode}: ${errors}`);
      }
      return lines[index];
    }).catch((error: Error) => {
      throw new Error(`${error.message}\n${errors}`);
    });
  return { line, stop: () => child.kill() };
}

function loadAlone(id: string, folder: string) {
  return docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "1000:1000",
    "--mount",
    `type=volume,src=${dataVolume},dst=/package,volume-subpath=packages/${id}/${folder},readonly`,
    nodeImage,
    "node",
    "--input-type=module",
    "-e",
    loadScript,
  );
}

describe("the apps' packages on real images", () => {
  let port: number;
  let staged: PackagesState;

  beforeAll(async () => {
    await build("apps/core/Dockerfile", coreImage);
    await build("apps/manager/Dockerfile", `${name("manager")}:real`);
    await createVolumes();
    port = await freePort();
    await startManager(coreImage, port);
    staged = await stagedFrom(await imageId(coreImage));
  }, 1_800_000);

  afterAll(async () => {
    await run("bash", ["deploy/dev/stack.sh", "down"], {
      SANCTUM_STACK: stack,
    }).catch(() => undefined);
  }, 120_000);

  it("stages each app the image ships, with the version it says", () => {
    expect(Object.keys(staged.apps).sort()).toEqual(
      shipped.map(({ id }) => id).sort(),
    );
    for (const { id, version } of shipped) {
      const current = staged.apps[id]?.current;
      expect(current?.version).toBe(version);
      expect(current?.folder.slice(0, version.length + 1)).toBe(`${version}+`);
      expect(current?.folder.slice(version.length + 1)).toMatch(
        /^[0-9a-f]{16}$/,
      );
    }
  });

  it("loads each package read-only, with nothing outside it", async () => {
    for (const { id } of shipped) {
      const out = await loadAlone(id, staged.apps[id]!.current.folder);
      expect(JSON.parse(out)).toEqual({
        id,
        loaded: id,
        writable: false,
        leaving: [],
      });
    }
  });

  it("runs the core on those apps with their own copies of the SDK", async () => {
    await waitFor("the core", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok ? true : undefined;
    });
    const logs = await run("sh", ["-c", `docker logs ${name("core")} 2>&1`]);
    expect(logs).not.toContain("was not loaded");
    expect(logs).not.toContain("was not installed");
  });

  it("answers through the apps' own copies of the SDK, their refusals included", async () => {
    const token = await claim();
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

    const apps = await call("/api/apps");
    expect(
      (apps.body as Array<{ id: string; state: string }>)
        .map(({ id, state }) => ({ id, state }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(
      shipped
        .map(({ id }) => ({ id, state: "running" }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    const listed = await call(
      "/api/apps/sanctum.moods/actions/moods.moods",
      {},
    );
    expect(listed.status).toBe(200);
    const refused = await call(
      "/api/apps/sanctum.moods/actions/moods.deleteMood",
      { id: "no-such-mood" },
    );
    expect(refused.status).toBe(404);
  });

  it("runs each app through its socket in the container the manager makes", async () => {
    await run("pnpm", [
      "turbo",
      "run",
      "build",
      "--ui=stream",
      "--output-logs=errors-only",
      "--filter=@meetsanctum/app-testkit",
    ]);
    await waitFor("the manager to run apps", async () => {
      const { body } = await api("GET", "/api/capabilities");
      return (body as { appContainers: boolean }).appContainers
        ? true
        : undefined;
    });

    for (const { id, version, runtime, permissions } of shipped) {
      const folder = staged.apps[id]!.current.folder;
      // A driver's start waits for its service, which this home's broker,
      // reachable by nobody, never gives it; then nothing else reaches it.
      const isWaiting = permissions.some((each) =>
        each.id.startsWith("services:"),
      );
      const started = await api("PUT", `/api/apps/${id}/container`, {
        folder,
        memoryMb: runtime.memory,
        dataMb: runtime.data,
      });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const peer = conformancePeer(id, folder);
      try {
        const report = JSON.parse(await peer.line(0)) as {
          expected: { manifest: string };
          reads: { action: string; outcome: { ok: boolean; code?: string } }[];
        };

        // What it names first is what was staged.
        expect(report).toMatchObject({
          hello: {
            type: "hello",
            protocol: expect.any(Number),
            app: id,
            version,
            manifest: report.expected.manifest,
          },
          prepared: { ready: true },
          ...(isWaiting
            ? {
                started: { ok: false, code: "not_ready" },
                startedAgain: { ok: false, code: "not_ready" },
                unknownAction: null,
                unknownDevice: null,
              }
            : {
                started: { ok: true },
                startedAgain: { ok: true },
                unknownAction: { ok: false, code: "not_found" },
                // A driver refuses a device it doesn't know, and an app with
                // no driver is unavailable for one.
                unknownDevice: {
                  ok: false,
                  code: expect.stringMatching(/^(not_found|unavailable)$/),
                },
              }),
          stopped: { ok: true },
          refused: [],
          lateAnswers: [],
          violations: [],
        });
        // Its read actions run on its image's database and in its memory
        // limit. One may refuse input it needs, but none of them fails.
        for (const { action, outcome } of report.reads) {
          expect(
            outcome.ok || outcome.code !== undefined,
            `${action}: ${JSON.stringify(outcome)}`,
          ).toBe(true);
        }

        const container = await docker(
          "ps",
          "--quiet",
          "--filter",
          `label=sanctum.stack=${stack}`,
          "--filter",
          `label=sanctum.app=${id}`,
        );
        expect(
          (await docker("exec", container, "ls", "-n", "/data"))
            .split("\n")
            .find((line) => line.endsWith(" app.db")),
        ).toMatch(/ 1000 +1000 /);

        // Told to stop with the app running: its hook runs and it exits at once.
        const before = Date.now();
        await api("POST", `/api/apps/${id}/container/stop`);
        expect(Date.now() - before).toBeLessThan(9_000);
        const { body } = await api("GET", `/api/apps/${id}/container`);
        expect(body).toMatchObject({
          state: "stopped",
          exitCode: 0,
          outOfMemory: false,
        });
        expect(JSON.parse(await peer.line(1))).toEqual({ closed: true });
      } finally {
        peer.stop();
        await api("DELETE", `/api/apps/${id}/container`);
      }
    }
  }, 300_000);

  it("has nothing to do after a restart", async () => {
    const before = await readState();
    const since = new Date().toISOString();
    await docker("restart", name("manager"));
    await waitFor("the manager", async () =>
      (await managerLogs(since)).includes("listening on") ? true : undefined,
    );
    // It looks as soon as it's ready.
    await new Promise((done) => setTimeout(done, 5000));

    expect(await readState()).toEqual(before);
    expect(await managerLogs(since)).not.toContain("Staged");
  });

  it("gives a new image's changed app a new folder and leaves the others", async () => {
    const before = await readState();
    const [changed, ...others] = shipped;
    await buildOnTop(
      nextCoreImage,
      `FROM ${coreImage}\nRUN echo '// changed' >> /app/catalog/official/${changed!.folder}/dist/index.js\n`,
    );
    // A stack's manager keeps a core it finds, as a host's does until an update.
    await docker("rm", "-f", name("manager"), name("core"));

    await startManager(nextCoreImage, port);
    const after = await stagedFrom(await imageId(nextCoreImage));

    const app = after.apps[changed!.id]!;
    expect(app.current.folder).not.toBe(
      before.apps[changed!.id]!.current.folder,
    );
    expect(app.previous).toEqual(before.apps[changed!.id]!.current);
    for (const { id } of others) {
      expect(after.apps[id]).toEqual(before.apps[id]);
    }
    for (const { id } of shipped) {
      const out = await loadAlone(id, after.apps[id]!.current.folder);
      expect(JSON.parse(out)).toMatchObject({ loaded: id });
    }
  }, 300_000);
});
