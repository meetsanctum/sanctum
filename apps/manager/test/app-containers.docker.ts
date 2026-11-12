import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A real stack's manager running real apps' containers, with test packages in
// its volume: what each can and can't do from inside, and that the core really
// reaches it through its socket.

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "../../..");
const stack = `test-apps-${randomBytes(3).toString("hex")}`;
const manager = `sanctum-${stack}-manager`;
const core = `sanctum-${stack}-core`;
const volume = `sanctum-${stack}-manager-data`;
const folder = "1.0.0+abcdef";

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

// The manager's API, through its socket, from inside its container.
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

// A package holding only a runner, where an app's copy of the SDK has one.
async function stage(app: string, runner: string) {
  const path = `/data/packages/${app}/${folder}`;
  const dist = `${path}/node_modules/@meetsanctum/app-sdk/dist`;
  await new Promise<void>((done, fail) => {
    const child = execFileCallback(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "-v",
        `${volume}:/data`,
        "alpine:latest",
        "sh",
        "-c",
        `mkdir -p ${dist} && echo '{}' > ${path}/package.json && cat > ${dist}/runner.js`,
      ],
      (error) => (error ? fail(error) : done()),
    );
    child.stdin?.end(runner);
  });
}

const reporting = `
  const fs = require("node:fs");
  const net = require("node:net");
  const os = require("node:os");
  const attempt = (work) => { try { work(); return "allowed"; } catch (error) { return error.code; } };
  const read = (path) => { try { return fs.readFileSync(path, "utf8").trim(); } catch (error) { return error.code; } };
  const status = read("/proc/self/status");
  console.log(JSON.stringify({
    uid: process.getuid(),
    capabilities: /CapEff:\\s+(\\S+)/.exec(status)[1],
    noNewPrivileges: /NoNewPrivs:\\s+(\\d)/.exec(status)[1],
    seccomp: /Seccomp:\\s+(\\d)/.exec(status)[1],
    writesItsRoot: attempt(() => fs.writeFileSync("/written", "")),
    writesItsPackage: attempt(() => fs.writeFileSync("/package/written", "")),
    writesItsSockets: attempt(() => fs.writeFileSync("/run/sanctum-app/written", "")),
    writesTemporary: attempt(() => fs.writeFileSync("/tmp/written", "")),
    networks: Object.keys(os.networkInterfaces()),
    memoryMax: read("/sys/fs/cgroup/memory.max"),
    swapMax: read("/sys/fs/cgroup/memory.swap.max"),
    pidsMax: read("/sys/fs/cgroup/pids.max"),
    cpuMax: read("/sys/fs/cgroup/cpu.max"),
    temporary: read("/proc/mounts").split("\\n").find((line) => line.includes(" /tmp ")),
    sockets: fs.readdirSync("/run/sanctum-app"),
    packageHas: fs.readdirSync("/package"),
  }));
  // Keeps trying the core's socket, as a runner does, and says what it hears.
  const reach = () => net.connect("/run/sanctum-app/core.sock")
    .on("data", (data) => console.log("heard " + data))
    .on("error", () => setTimeout(reach, 250));
  reach();
  setInterval(() => undefined, 60_000);
`;

const logsOf = (app: string) =>
  run("sh", ["-c", `docker logs sanctum-${stack}-app-${app} 2>&1`]);

const reportOf = async (app: string) =>
  JSON.parse(
    await waitFor(`${app}'s report`, async () => {
      const [line] = (await logsOf(app)).split("\n");
      return line?.startsWith("{") ? line : undefined;
    }),
  ) as Record<string, unknown>;

describe("apps' containers on real Docker", () => {
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
    await stage("test.reporter", reporting);
    await stage("test.other", reporting);
    await stage("test.quits", "process.exit(3);");
    await stage(
      "test.hog",
      `const kept = []; for (;;) kept.push(Buffer.alloc(10 * 1024 * 1024, 1));`,
    );
  }, 600_000);

  afterAll(async () => {
    await run("bash", ["deploy/dev/stack.sh", "down"], {
      SANCTUM_STACK: stack,
    }).catch(() => undefined);
  }, 120_000);

  it("says it can run apps, once the core has its folders", async () => {
    const { body } = await waitFor("the manager to say so", async () => {
      const answer = await api("GET", "/api/capabilities");
      return (answer.body as { appContainers: boolean }).appContainers
        ? answer
        : undefined;
    });

    expect(body).toEqual({ appContainers: true, memoryLimits: true });
  });

  it("starts one, and what it can do is what the standard allows", async () => {
    const started = await api("PUT", "/api/apps/test.reporter/container", {
      folder,
      memoryMb: 128,
    });
    expect(started).toMatchObject({
      status: 200,
      body: { state: "running", folder, memoryMb: 128 },
    });

    expect(await reportOf("test.reporter")).toMatchObject({
      uid: 1000,
      capabilities: "0000000000000000",
      noNewPrivileges: "1",
      // Docker's own seccomp profile.
      seccomp: "2",
      writesItsRoot: "EROFS",
      writesItsPackage: "EROFS",
      writesItsSockets: "EROFS",
      writesTemporary: "allowed",
      networks: ["lo"],
      memoryMax: String(128 * 1024 * 1024),
      swapMax: "0",
      pidsMax: "64",
      cpuMax: "50000 100000",
      temporary: expect.stringContaining("size=16384k"),
      packageHas: ["node_modules", "package.json"],
    });
  });

  it("reaches the core's socket, though its folder is read-only to it", async () => {
    const socket = "/run/sanctum-apps/test.reporter/core.sock";
    const serving = docker(
      "exec",
      core,
      "node",
      "-e",
      `const net = require("node:net");
       const server = net.createServer((connection) =>
         connection.end("hello from the core", () => server.close()));
       server.listen(${JSON.stringify(socket)}, () =>
         require("node:fs").chmodSync(${JSON.stringify(socket)}, 0o666));
       setTimeout(() => process.exit(1), 30000).unref();`,
    );

    const heard = await waitFor("the app to hear the core", async () => {
      const logs = await logsOf("test.reporter");
      return logs.includes("heard hello from the core") ? true : undefined;
    });

    expect(heard).toBe(true);
    await serving;
  });

  it("sees only its own folders, while the core sees them read-only", async () => {
    await docker("exec", core, "touch", "/run/sanctum-apps/test.reporter/mine");
    await api("PUT", "/api/apps/test.other/container", {
      folder,
      memoryMb: 64,
    });

    const report = await reportOf("test.other");

    // Empty as it looked: what is in the other app's folder is out of sight.
    expect(report.sockets).toEqual([]);
    expect(
      await docker("exec", core, "ls", "/packages/test.reporter"),
    ).toContain(folder);
    await expect(
      docker("exec", core, "touch", "/packages/test.reporter/written"),
    ).rejects.toThrow("Read-only");
  });

  it("says how one stopped, and Docker doesn't start it again", async () => {
    await api("PUT", "/api/apps/test.quits/container", {
      folder,
      memoryMb: 64,
    });

    const stopped = await waitFor("it to stop", async () => {
      const { body } = await api("GET", "/api/apps/test.quits/container");
      return (body as { state: string }).state === "stopped" ? body : undefined;
    });

    expect(stopped).toMatchObject({ exitCode: 3, outOfMemory: false });
    await new Promise((done) => setTimeout(done, 1500));
    const { body } = await api("GET", "/api/apps/test.quits/container");
    expect(body).toMatchObject({ state: "stopped", exitCode: 3 });
  });

  it("holds one to its memory, and says that's why it stopped", async () => {
    await api("PUT", "/api/apps/test.hog/container", { folder, memoryMb: 64 });

    const stopped = await waitFor("it to run out", async () => {
      const { body } = await api("GET", "/api/apps/test.hog/container");
      return (body as { state: string }).state === "stopped" ? body : undefined;
    });

    expect(stopped).toMatchObject({ exitCode: 137, outOfMemory: true });
  });

  it("refuses a package that isn't there", async () => {
    const missing = await api("PUT", "/api/apps/test.none/container", {
      folder,
      memoryMb: 64,
    });
    expect(missing.status).toBe(404);
  });

  it("reports them in the host's memory", async () => {
    const { body } = await api("GET", "/api/host/status");
    const { memory, memoryLimits } = body as {
      memoryLimits: boolean;
      memory: { containers: Array<{ role: string; app?: string }> };
    };

    expect(memoryLimits).toBe(true);
    expect(memory.containers).toContainEqual(
      expect.objectContaining({ role: "app", app: "test.reporter" }),
    );
  });

  it("stops and removes one", async () => {
    const stopped = await api("POST", "/api/apps/test.reporter/container/stop");
    expect(stopped.body).toMatchObject({ state: "stopped" });

    const removed = await api("DELETE", "/api/apps/test.reporter/container");
    expect(removed.status).toBe(204);
    await expect(
      docker("inspect", `sanctum-${stack}-app-test.reporter`),
    ).rejects.toThrow();
  });

  it("goes with its stack", async () => {
    await run("bash", ["deploy/dev/stack.sh", "down"], {
      SANCTUM_STACK: stack,
    });

    expect(
      await docker(
        "ps",
        "-a",
        "--filter",
        `label=sanctum.stack=${stack}`,
        "--format",
        "{{.Names}}",
      ),
    ).toBe("");
    // Its images' loop devices would hold on to their space until Docker
    // restarts.
    expect(
      await docker(
        "run",
        "--rm",
        "--privileged",
        "alpine:latest",
        "losetup",
        "-a",
      ),
    ).not.toMatch(/test\.(reporter|other|quits|hog)\.img/);
  }, 120_000);
});
