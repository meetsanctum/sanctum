import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Two real development stacks on one Docker, as parallel sessions run them
// (deploy/dev/stack.sh). Each runs its apps apart from the worktree's build,
// and both follow a new one. One is updated, manager included, cleaned up and
// torn down while the other keeps running, untouched.

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "../../..");
const suffix = randomBytes(3).toString("hex");
const updated = "dev-test2";

async function run(command: string, args: string[], env: object = {}) {
  const { stdout } = await execFile(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

const docker = (...args: string[]) => run("docker", args);

async function isFree(port: number) {
  const server = createServer();
  const free = await new Promise<boolean>((done) => {
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => done(true));
  });
  if (free) await new Promise((done) => server.close(done));
  return free;
}

// A free pair of ports from here on: the stack's core and its registry after
// it.
async function freePorts(from: number): Promise<number> {
  for (let port = from; port < from + 1000; port += 2) {
    if ((await isFree(port)) && (await isFree(port + 1))) return port;
  }
  throw new Error(`No free ports from ${from}`);
}

function stackOf(role: string, port: number, registry: boolean) {
  const name = `test-${role}-${suffix}`;
  const settings = {
    SANCTUM_STACK: name,
    SANCTUM_STACK_PORT: String(port),
    SANCTUM_STACK_HTTPS: "true",
    SANCTUM_STACK_REGISTRY: String(registry),
  };
  const manager = `sanctum-${name}-manager`;
  return {
    name,
    port,
    manager,
    core: `sanctum-${name}-core`,
    app: (id: string) => `sanctum-${name}-app-${id}`,
    script: (command: string, env: NodeJS.ProcessEnv = {}) =>
      run("bash", ["deploy/dev/stack.sh", command], { ...settings, ...env }),
    // Over HTTPS, trusting only that stack's host CA, as the update path does.
    health: async () =>
      JSON.parse(
        await docker("exec", manager, "node", "dist/cli.js", "core-health"),
      ) as { status: string; version: string; uptimeSeconds: number },
    // The manager's API, through its socket, from inside its container.
    api: async (method: string, path: string) => {
      const out = await docker(
        "exec",
        manager,
        "node",
        "-e",
        `const http = require("node:http");
         const request = http.request(
           { socketPath: "/run/sanctum/manager.sock", path: ${JSON.stringify(path)}, method: ${JSON.stringify(method)} },
           (response) => {
             let body = "";
             response.on("data", (chunk) => (body += chunk));
             response.on("end", () => console.log(JSON.stringify({ status: response.statusCode, body })));
           },
         );
         request.end();`,
      );
      const { status, body } = JSON.parse(out) as {
        status: number;
        body: string;
      };
      return { status, body: JSON.parse(body) as unknown };
    },
    resources: async () => ({
      containers: await docker(
        "ps",
        "-a",
        "--filter",
        `label=sanctum.stack=${name}`,
        "--format",
        "{{.Names}}",
      ),
      volumes: await docker(
        "volume",
        "ls",
        "--filter",
        `label=sanctum.stack=${name}`,
        "--format",
        "{{.Name}}",
      ),
      networks: await docker(
        "network",
        "ls",
        "--filter",
        `label=sanctum.stack=${name}`,
        "--format",
        "{{.Name}}",
      ),
    }),
  };
}

type Stack = ReturnType<typeof stackOf>;

// The core answers before it has started its apps, each in its container:
// those these tests use, the fake lights and Weather.
async function appsRunning(stack: Stack) {
  await vi.waitFor(
    async () => {
      const running = await docker(
        "ps",
        "--filter",
        `label=sanctum.stack=${stack.name}`,
        "--filter",
        "label=sanctum.role=app",
        "--format",
        '{{.Label "sanctum.app"}}',
      );
      expect(running.split("\n")).toEqual(
        expect.arrayContaining(["sanctum.fake-lights", "sanctum.weather"]),
      );
    },
    { timeout: 120_000, interval: 1_000 },
  );
}

// A later build of a stack's image in its own registry, to update to.
async function publish(stack: Stack, registryPort: number, service: string) {
  const tag = `localhost:${registryPort}/sanctum-${service}:${updated}`;
  await new Promise<void>((done, fail) => {
    const build = execFileCallback(
      "docker",
      ["build", "-q", "-t", tag, "-"],
      { cwd: root },
      (error) => (error ? fail(error) : done()),
    );
    build.stdin?.end(
      `FROM sanctum-${stack.name}-${service}:dev\n` +
        `ENV SANCTUM_VERSION=${updated}\n` +
        `LABEL org.opencontainers.image.version=${updated}\n`,
    );
  });
  await docker("push", "-q", tag);
}

describe("two stacks on one Docker", () => {
  let one: Stack;
  let other: Stack;

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
    const first = await freePorts(
      44000 + (randomBytes(2).readUInt16BE() % 4000),
    );
    one = stackOf("one", first, true);
    other = stackOf("other", await freePorts(first + 2), false);
    await one.script("up");
    await other.script("up");
    await appsRunning(one);
    await appsRunning(other);
  }, 600_000);

  afterAll(async () => {
    await one?.script("down").catch(() => undefined);
    await other?.script("down").catch(() => undefined);
  }, 120_000);

  it("runs a core and a manager for each", async () => {
    expect((await one.health()).status).toBe("ok");
    expect((await other.health()).status).toBe("ok");
    expect(await docker("port", one.core, "4100/tcp")).toContain(
      `127.0.0.1:${one.port}`,
    );
    expect(await docker("port", other.core, "4100/tcp")).toContain(
      `127.0.0.1:${other.port}`,
    );
  });

  it("runs its fake lights apart, confirming colour and white commands in the requested mode", async () => {
    const states = JSON.parse(
      await docker(
        "exec",
        one.app("sanctum.fake-lights"),
        "node",
        "--input-type=module",
        "-e",
        `const { default: app } = await import("/package/index.js");
       const states = [];
       const ctx = { devices: { report: ({ states: { light } }) => states.push(light) } };
       for (const command of [{ hue: 120, saturation: 60 }, { colorTemperature: 250 }, { on: true }]) {
         await app.driver.command(ctx, { key: "floor", command });
       }
       console.log(JSON.stringify(states));`,
      ),
    );

    expect(states).toEqual([
      expect.objectContaining({ colorMode: "color", hue: 120, saturation: 60 }),
      expect.objectContaining({
        colorMode: "temperature",
        colorTemperature: 250,
      }),
      expect.objectContaining({
        on: true,
        colorMode: "temperature",
        colorTemperature: 250,
      }),
    ]);
  });

  it.each(["running", "stopped"])(
    "updates a worktree build in both stacks with one manager %s",
    async (managerState) => {
      const built = join(root, "catalog/apps/weather/dist/index.js");
      const original = await readFile(built, "utf8");
      const folderOf = (stack: Stack) =>
        docker(
          "inspect",
          "-f",
          '{{index .Config.Labels "sanctum.app.folder"}}',
          stack.app("sanctum.weather"),
        ).catch(() => "");
      const before = await folderOf(one);
      expect(before).toMatch(/^0\.\d+\.\d+\+[0-9a-f]{16}$/);
      expect(await folderOf(other)).toBe(before);
      // Until both run that build's package and their update has ended.
      const settled = (folder: (now: string) => boolean) =>
        vi.waitFor(
          async () => {
            for (const stack of [one, other]) {
              expect(folder(await folderOf(stack))).toBe(true);
              const { body } = await stack.api("GET", "/api/apps/updates");
              expect(body).toEqual({ updates: {} });
            }
          },
          { timeout: 120_000, interval: 1_000 },
        );

      try {
        if (managerState === "stopped") await docker("stop", one.manager);
        await writeFile(built, `${original}\n// A new build.\n`);
        if (managerState === "stopped") await docker("start", one.manager);
        await settled((now) => now !== "" && now !== before);
        const after = await folderOf(one);
        expect(after).toMatch(/^0\.\d+\.\d+\+[0-9a-f]{16}$/);
        expect(await folderOf(other)).toBe(after);
      } finally {
        await writeFile(built, original);
      }
      // And back, so what follows starts from the build it had.
      await settled((now) => now === before);
    },
    300_000,
  );

  it("reports only its own containers in Status", async () => {
    const { body } = await one.api("GET", "/api/host/status");
    const { memory } = body as {
      memory: { containers: Array<{ role: string }> };
    };
    const running = await docker(
      "ps",
      "--filter",
      `label=sanctum.stack=${one.name}`,
      "--filter",
      "label=sanctum.role=core",
      "--format",
      "{{.Names}}",
    );

    expect(running).toBe(one.core);
    expect(
      memory.containers.filter((container) => container.role === "core"),
    ).toHaveLength(1);
  });

  it("refuses to restart or shut down the machine", async () => {
    expect((await one.api("POST", "/api/host/restart")).status).toBe(409);
    expect((await one.api("POST", "/api/host/shutdown")).status).toBe(409);
  });

  it("updates one, manager included, and leaves the other alone", async () => {
    const before = await docker(
      "inspect",
      "-f",
      "{{.Id}} {{.Image}}",
      other.core,
      other.manager,
    );
    const registryPort = one.port + 1;
    await publish(one, registryPort, "core");
    await publish(one, registryPort, "manager");

    // Outside the manager, since the update replaces its container.
    await docker(
      "run",
      "--rm",
      "-v",
      `sanctum-${one.name}-manager-socket:/run/sanctum`,
      "-v",
      `${root}/apps/manager/dist:/app/apps/manager/dist:ro`,
      `sanctum-${one.name}-manager:dev`,
      "node",
      "dist/cli.js",
      "update",
      updated,
    );

    expect((await one.health()).version).toBe(updated);
    expect(
      await docker(
        "inspect",
        "-f",
        "{{range .Config.Env}}{{println .}}{{end}}",
        one.manager,
      ),
    ).toContain(`SANCTUM_VERSION=${updated}`);
    expect(
      await docker(
        "inspect",
        "-f",
        "{{.Id}} {{.Image}}",
        other.core,
        other.manager,
      ),
    ).toBe(before);
    expect((await other.health()).version).toBe("dev-stack");
  }, 300_000);

  it("frees space in one without touching the other's images", async () => {
    const { status } = await one.api("POST", "/api/host/space/free");

    expect(status).toBe(200);
    await docker("image", "inspect", `sanctum-${other.name}-core:dev`);
    await docker("image", "inspect", `sanctum-${other.name}-manager:dev`);
    expect((await other.health()).status).toBe("ok");
  }, 120_000);

  it("applies HTTP and origin changes while keeping the home's data", async () => {
    const http = { SANCTUM_STACK_HTTPS: "false", CORE_ALLOWED_ORIGINS: "" };
    const origins = "http://localhost:5173";
    const coreEnv = () =>
      docker(
        "inspect",
        "-f",
        "{{range .Config.Env}}{{println .}}{{end}}",
        other.core,
      );
    // Seed the HTTPS core from a new shell without the flag used to start it.
    expect(await other.script("seed", http)).toContain(
      "Seeded: 3 rooms and 4 fake lights.",
    );
    await other.script("up", { ...http, CORE_ALLOWED_ORIGINS: origins });
    expect(await coreEnv()).toContain(`CORE_ALLOWED_ORIGINS=${origins}`);
    expect(await other.script("seed", http)).toContain("already claimed");

    await other.script("stop");
    await other.script("up", http);

    expect(await coreEnv()).toContain("CORE_ALLOWED_ORIGINS=app://sanctum");
    expect(await coreEnv()).not.toContain(origins);
    expect(await other.script("seed", http)).toContain("already claimed");
    const before = await docker("inspect", "-f", "{{.Id}}", other.core);

    await other.script("up", http);

    expect(await docker("inspect", "-f", "{{.Id}}", other.core)).toBe(before);
    expect((await other.health()).status).toBe("ok");
  }, 120_000);

  it("tears one down and the other keeps running", async () => {
    const running = await docker("inspect", "-f", "{{.Id}}", other.core);

    await one.script("down");

    expect(await one.resources()).toEqual({
      containers: "",
      volumes: "",
      networks: "",
    });
    expect(await docker("inspect", "-f", "{{.Id}}", other.core)).toBe(running);
    expect((await other.health()).status).toBe("ok");
  }, 120_000);
});
