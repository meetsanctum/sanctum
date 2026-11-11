import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const script = resolve(import.meta.dirname, "../../../deploy/dev/stack.sh");
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// Exercise the real CLI with a Docker double, so a failed startup cannot leave
// containers behind and settings changes are checked without starting a stack.
async function worktree() {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-stack-script-"));
  folders.push(folder);
  const root = join(folder, "same-worktree-name");
  const bin = join(folder, "bin");
  const commands = join(folder, "commands.jsonl");
  await mkdir(join(root, "deploy/dev/apps"), { recursive: true });
  await mkdir(bin);
  await cp(script, join(root, "deploy/dev/stack.sh"));
  await writeFile(join(root, "deploy/dev/seed.mjs"), "");
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
if (args[0] === "inspect") {
  const format = args[2];
  if (format.includes(".Config.Env")) console.log("CORE_PLAIN_HTTP=" + (process.env.STACK_TEST_PLAIN_HTTP ?? "true") + "\\nCORE_ALLOWED_ORIGINS=app://sanctum");
  if (format.includes(".HostConfig.PortBindings")) console.log("45000");
  if (format === "{{.Image}}") console.log("sha256:current");
  if (format.includes('"sanctum.stack.core-binds"')) console.log(
    process.cwd() + "/deploy/dev/apps:/app/deploy/dev/apps:ro" +
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
    run: (command: string, env: NodeJS.ProcessEnv = {}) =>
      execFile("bash", ["deploy/dev/stack.sh", command], {
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

describe("development stack CLI", () => {
  it("keeps a core whose settings still match", async () => {
    const tree = await worktree();

    await tree.run("up");

    expect(await tree.commands()).not.toContainEqual([
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

  it("drops mounts for app packages removed from the worktree", async () => {
    const tree = await worktree();

    await tree.run("up", {
      STACK_TEST_OLD_BIND: ";/removed/app:/app/catalog/apps/removed/dist:ro",
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
