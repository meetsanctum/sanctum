import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const script = resolve(import.meta.dirname, "../../../deploy/dev/stack.sh");
// The fake devices' rooms, which the seed is given from the worktree.
const fakeHome = resolve(
  import.meta.dirname,
  "../../../deploy/dev/apps/fake-lights/home.js",
);
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function holdDisplayPort() {
  const server = createServer();
  await new Promise<void>((done, fail) => {
    server.once("error", fail).listen(0, "0.0.0.0", done);
  });
  return {
    port: String((server.address() as AddressInfo).port),
    close: promisify(server.close.bind(server)),
  };
}

// Exercise the real CLI with a Docker double, so a failed startup cannot leave
// containers behind and settings changes are checked without starting a stack.
async function worktree() {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-stack-script-"));
  folders.push(folder);
  const root = join(folder, "same-worktree-name");
  const bin = join(folder, "bin");
  const commands = join(folder, "commands.jsonl");
  await mkdir(join(root, "apps/core/dist"), { recursive: true });
  await mkdir(bin);
  await cp(script, join(root, "deploy/dev/stack.sh"));
  await writeFile(join(root, "deploy/dev/seed.mjs"), "");
  await cp(fakeHome, join(root, "deploy/dev/apps/fake-lights/home.js"));
  await writeFile(join(root, "deploy/dev/approve.mjs"), "");
  await writeFile(commands, "");
  await writeFile(
    join(bin, "docker.mjs"),
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.STACK_TEST_COMMANDS, JSON.stringify(args) + "\\n");
if (args[0] === "port") console.log("127.0.0.1:45000");
if (args[0] === "image" && args[1] === "inspect") console.log("sha256:current");
if (args[0] === "compose" && process.env.STACK_TEST_FAIL_COMPOSE) process.exit(1);
if (args[0] === "compose" && args.includes("up")) {
  appendFileSync(process.env.STACK_TEST_COMMANDS, JSON.stringify([
    "stack-env", process.env.SANCTUM_STACK_CORE_ENV,
    process.env.SANCTUM_DISPLAY_ENABLED, process.env.SANCTUM_DISPLAY_PORT,
  ]) + "\\n");
}
if (args[0] === "inspect") {
  const format = args[2];
  if (format.includes(".Config.Env")) {
    console.log("CORE_PLAIN_HTTP=" + (process.env.STACK_TEST_PLAIN_HTTP ?? "true"));
    console.log("CORE_ALLOWED_ORIGINS=app://sanctum");
    if (!process.env.STACK_TEST_NO_NEW_HOME_APPS) {
      console.log("CORE_NEW_HOME_APPS=sanctum.moods,sanctum.natural-light,sanctum.weather,sanctum.fake-lights");
    }
  }
  if (format.includes('PortBindings "4100/tcp"')) console.log("45000");
  if (format.includes('PortBindings "4180/tcp"')) console.log(process.env.STACK_TEST_SPEAKER_PORT ?? "45002");
  if (format === "{{.Image}}") console.log("sha256:current");
  if (format.includes('"sanctum.stack.core-binds"')) console.log(
    process.cwd() + "/apps/core/dist:/app/apps/core/dist:ro" +
    (process.env.STACK_TEST_OLD_BIND ?? ""));
  else if (format.includes(".Config.Labels")) console.log(
    args.at(-1).endsWith("-core")
      ? (process.env.STACK_TEST_CORE_OWNER ?? "one")
      : (process.env.STACK_TEST_MANAGER_OWNER ?? "one"));
}
`,
    { mode: 0o755 },
  );
  // Use .mjs for ESM even outside the repository's packages.
  await writeFile(
    join(bin, "docker"),
    '#!/usr/bin/env bash\nexec node "$(dirname "$0")/docker.mjs" "$@"\n',
    { mode: 0o755 },
  );
  for (const command of ["pnpm", "curl", "nc"]) {
    await writeFile(
      join(bin, command),
      `#!/usr/bin/env bash\nexit ${command === "nc" ? 1 : 0}\n`,
      { mode: 0o755 },
    );
  }

  return {
    root,
    run: (command: string, env: NodeJS.ProcessEnv = {}, args: string[] = []) =>
      execFile("bash", ["deploy/dev/stack.sh", command, ...args], {
        cwd: root,
        env: {
          ...process.env,
          SANCTUM_STACK: "one",
          SANCTUM_STACK_PORT: "45000",
          SANCTUM_STACK_HTTPS: "false",
          CORE_ALLOWED_ORIGINS: "",
          PATH: `${bin}:${process.env.PATH}`,
          STACK_TEST_COMMANDS: commands,
          ...env,
        },
      }),
    commands: async () =>
      (await readFile(commands, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  };
}

// Each test runs the real script through bash, a second here and several on
// a shared CI runner, so they have longer than vitest's 5 s.
describe("development stack CLI", { timeout: 20_000 }, () => {
  it("keeps a core whose settings still match", async () => {
    const tree = await worktree();

    await tree.run("up");

    expect(await tree.commands()).not.toContainEqual([
      "rm",
      "-f",
      "sanctum-one-core",
    ]);
  });

  it("recreates a core without the port speakers fetch announcements from", async () => {
    const tree = await worktree();

    await tree.run("up", { STACK_TEST_SPEAKER_PORT: "" });

    expect(await tree.commands()).toContainEqual([
      "rm",
      "-f",
      "sanctum-one-core",
    ]);
  });

  it("recreates the core when allowed browser origins change", async () => {
    const tree = await worktree();

    await tree.run("up", { CORE_ALLOWED_ORIGINS: "http://localhost:5173" });

    expect(await tree.commands()).toContainEqual([
      "rm",
      "-f",
      "sanctum-one-core",
    ]);
  });

  it("recreates a core that started without its starter app setting", async () => {
    const tree = await worktree();

    await tree.run("up", { STACK_TEST_NO_NEW_HOME_APPS: "1" });

    const commands = await tree.commands();
    expect(commands).toContainEqual(["rm", "-f", "sanctum-one-core"]);
    expect(commands).toContainEqual(["restart", "sanctum-one-manager"]);
  });

  it("drops mounts for packages removed from the worktree", async () => {
    const tree = await worktree();

    await tree.run("up", {
      STACK_TEST_OLD_BIND: ";/removed/dist:/app/packages/removed/dist:ro",
    });

    expect(await tree.commands()).toContainEqual([
      "rm",
      "-f",
      "sanctum-one-core",
    ]);
  });

  it("stops a partially started stack when startup fails", async () => {
    const tree = await worktree();

    await expect(
      tree.run("dev", { STACK_TEST_FAIL_COMPOSE: "1" }),
    ).rejects.toThrow();

    expect(await tree.commands()).toContainEqual([
      "stop",
      "sanctum-one-manager",
    ]);
  });

  it("stops the updater before the manager during shutdown", async () => {
    const tree = await worktree();

    await tree.run("stop");

    const stops = (await tree.commands()).filter(
      ([command]) => command === "stop",
    );
    expect(stops.slice(0, 2)).toEqual([
      ["stop", "sanctum-one-manager-updater"],
      ["stop", "sanctum-one-manager"],
    ]);
  });

  it("gives equally named worktree folders distinct default stacks", async () => {
    const one = await worktree();
    const other = await worktree();

    const first = await one.run("status", { SANCTUM_STACK: "" });
    const second = await other.run("status", { SANCTUM_STACK: "" });

    expect(first.stdout.split("\n")[0]).not.toBe(second.stdout.split("\n")[0]);
  });

  it("seeds an HTTPS core from a shell using the default HTTP settings", async () => {
    const tree = await worktree();

    await tree.run("seed", { STACK_TEST_PLAIN_HTTP: "false" });

    const exec = (await tree.commands()).find(
      ([command]) => command === "exec",
    );
    expect(exec).toContain("SEED_CORE_URL=https://127.0.0.1:4100");
    expect(exec).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
    const rooms = exec
      ?.find((arg) => arg.startsWith("SEED_ROOMS="))
      ?.slice("SEED_ROOMS=".length);
    expect(Object.keys(JSON.parse(rooms!))).toHaveLength(9);
  });

  it("approves a pairing code as the seed does, with the name given", async () => {
    const tree = await worktree();

    await tree.run("approve", {}, ["ABCD-EFGH", "Hall display"]);

    const exec = (await tree.commands()).find(
      ([command]) => command === "exec",
    );
    expect(exec).toContain("SEED_CORE_URL=http://127.0.0.1:4100");
    expect(exec).toContain("APPROVE_CODE=ABCD-EFGH");
    expect(exec).toContain("APPROVE_NAME=Hall display");
    expect(exec).toContain("sanctum-one-core");
  });

  it("refuses to approve through a core belonging to another stack", async () => {
    const tree = await worktree();

    await expect(
      tree.run("approve", { STACK_TEST_CORE_OWNER: "another-stack" }, [
        "ABCD-EFGH",
      ]),
    ).rejects.toThrow("it doesn't belong to stack one");
    expect(
      (await tree.commands()).some(([command]) => command === "exec"),
    ).toBe(false);
  });

  it("sets the display port for Vite and preserves configured origins", async () => {
    const tree = await worktree();
    const { port, close } = await holdDisplayPort();
    await close();

    await tree.run("display", {
      SANCTUM_DISPLAY_PORT: port,
      CORE_ALLOWED_ORIGINS: "app://sanctum,http://localhost:5173",
    });

    const settings = (await tree.commands()).find(
      ([command]) => command === "stack-env",
    );
    expect(settings?.slice(2)).toEqual(["true", port]);
    expect(settings?.[1]).toContain(
      "CORE_ALLOWED_ORIGINS=app://sanctum,http://localhost:5173",
    );
  });

  it("rejects an invalid display port before starting Docker", async () => {
    const tree = await worktree();

    await expect(
      tree.run("display", { SANCTUM_DISPLAY_PORT: "0" }),
    ).rejects.toThrow("SANCTUM_DISPLAY_PORT must be a port from 1 to 65535");
    expect(await tree.commands()).toEqual([]);
  });

  it("rejects an occupied display port before starting Docker", async () => {
    const tree = await worktree();
    const { port, close } = await holdDisplayPort();
    try {
      await expect(
        tree.run("display", { SANCTUM_DISPLAY_PORT: port }),
      ).rejects.toThrow(`Cannot use display port ${port}`);
      expect(await tree.commands()).toEqual([]);
    } finally {
      await close();
    }
  });

  it.each(["", "another-stack"])(
    "refuses a same-name core labelled %j",
    async (owner) => {
      const tree = await worktree();

      await expect(
        tree.run("up", {
          STACK_TEST_CORE_OWNER: owner,
          CORE_ALLOWED_ORIGINS: "http://localhost:5173",
        }),
      ).rejects.toThrow("Refusing");

      expect(await tree.commands()).not.toContainEqual([
        "rm",
        "-f",
        "sanctum-one-core",
      ]);
    },
  );

  it("leaves a same-name manager belonging to another stack running", async () => {
    const tree = await worktree();

    await tree.run("stop", { STACK_TEST_MANAGER_OWNER: "another-stack" });

    expect(await tree.commands()).not.toContainEqual([
      "stop",
      "sanctum-one-manager",
    ]);
    expect(await tree.commands()).not.toContainEqual([
      "stop",
      "sanctum-one-manager-updater",
    ]);
  });
});
