import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const scriptPath = resolve(import.meta.dirname, "../../../deploy/install.sh");
const composePath = resolve(import.meta.dirname, "../../../deploy/compose.yml");
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

// Run the installer with its real entry point and Docker commands, replacing
// machine checks and host settings so these tests need neither root nor Docker.
async function installation() {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-install-script-"));
  folders.push(folder);
  const dir = join(folder, "sanctum");
  const bin = join(folder, "bin");
  const commands = join(folder, "commands.jsonl");
  const changes = join(folder, "changes");
  await mkdir(dir);
  await mkdir(bin);
  await writeFile(commands, "");
  await writeFile(changes, "");
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const env = process.env;
appendFileSync(env.INSTALL_TEST_COMMANDS, JSON.stringify({
  args,
  channel: env.SANCTUM_CHANNEL,
  owner: env.SANCTUM_IMAGE_OWNER,
  image: env.SANCTUM_MANAGER_IMAGE,
}) + "\\n");
if (args[0] === "inspect") {
  if (!env.INSTALL_TEST_MANAGER) process.exit(1);
  const format = args.join(" ");
  if (format.includes(".State.Running")) console.log(env.INSTALL_TEST_MANAGER === "running");
  if (format.includes("com.docker.compose.project.config_files")) console.log(env.INSTALL_TEST_COMPOSE ?? env.INSTALL_TEST_DIR + "/compose.yml");
  else if (format.includes("com.docker.compose.project")) console.log("sanctum");
  else if (format.includes("com.docker.compose.service")) console.log("manager");
}
if (args[0] === "image") console.log(args.join(" ").includes("revision") ? "123abc" : "https://github.com/meetsanctum/sanctum");
if (args[0] === "pull" && env.INSTALL_TEST_FAIL_PULL) process.exit(1);
if (args[0] === "compose" && args.includes("up") && env.INSTALL_TEST_FAIL_START) process.exit(1);
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "curl"),
    '#!/usr/bin/env bash\nwhile [[ "$1" != -o ]]; do shift; done\ncp "$INSTALL_TEST_COMPOSE_SOURCE" "$2"\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "timeout"),
    '#!/usr/bin/env bash\nshift\nexec "$@"\n',
    {
      mode: 0o755,
    },
  );
  const definitions = (await readFile(scriptPath, "utf8")).replace(
    /\nmain "\$@"\s*$/,
    "\n",
  );
  const setup = `${definitions}
dir="$INSTALL_TEST_DIR"
script=""
check_machine() { :; }
enable_memory_limits() { echo memory >>"$INSTALL_TEST_CHANGES"; }
keep_awake() { echo awake >>"$INSTALL_TEST_CHANGES"; }
`;
  const runShell = (
    body: string,
    args: string[],
    env: NodeJS.ProcessEnv = {},
  ) =>
    execFile("bash", ["-c", setup + body, "install-test", ...args], {
      cwd: folder,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SANCTUM_IMAGE_OWNER: "",
        SANCTUM_CHANNEL: "",
        SANCTUM_MANAGER_IMAGE: "",
        INSTALL_TEST_DIR: dir,
        INSTALL_TEST_COMMANDS: commands,
        INSTALL_TEST_CHANGES: changes,
        INSTALL_TEST_COMPOSE_SOURCE: composePath,
        ...env,
      },
    });

  return {
    dir,
    run: (args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
      runShell('main "$@"', args, env),
    runShell,
    save: async (channel = "edge", owner = "meetsanctum") => {
      await writeFile(join(dir, "compose.yml"), await readFile(composePath));
      await writeFile(
        join(dir, ".env"),
        `SANCTUM_IMAGE_OWNER=${owner}\nSANCTUM_CHANNEL=${channel}\n`,
      );
    },
    settings: () => readFile(join(dir, ".env"), "utf8"),
    changes: () => readFile(changes, "utf8"),
    commands: async () =>
      (await readFile(commands, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              args: string[];
              channel?: string;
              owner?: string;
              image?: string;
            },
        ),
  };
}

describe("host installer", () => {
  it("refuses another installation before changing host settings", async () => {
    const host = await installation();

    await expect(
      host.run([], { INSTALL_TEST_MANAGER: "running" }),
    ).rejects.toThrow("set up another way");

    expect(await host.changes()).toBe("");
  });

  it("checks the existing manager belongs to its compose file", async () => {
    const host = await installation();
    await host.save();

    await expect(
      host.run([], {
        INSTALL_TEST_MANAGER: "running",
        INSTALL_TEST_COMPOSE: "/another/compose.yml",
      }),
    ).rejects.toThrow("set up another way");

    expect(await host.changes()).toBe("");
  });

  it("refuses a channel change before changing host settings", async () => {
    const host = await installation();
    await host.save();

    await expect(
      host.run(["--channel", "stable"], { INSTALL_TEST_MANAGER: "running" }),
    ).rejects.toThrow("does not change it");

    expect(await host.changes()).toBe("");
  });

  it("leaves a running manager alone", async () => {
    const host = await installation();
    await host.save();

    await host.run([], { INSTALL_TEST_MANAGER: "running" });

    const commands = (await host.commands()).map(({ args }) => args);
    expect(commands.some(([command]) => command === "pull")).toBe(false);
    expect(commands).not.toContainEqual(["start", "sanctum-manager"]);
    expect(commands.some((args) => args.includes("up"))).toBe(false);
  });

  it("starts a stopped manager without recreating its updated image", async () => {
    const host = await installation();
    await host.save();

    await host.run([], { INSTALL_TEST_MANAGER: "stopped" });

    const commands = (await host.commands()).map(({ args }) => args);
    expect(commands).toContainEqual(["start", "sanctum-manager"]);
    expect(commands.some((args) => args.includes("up"))).toBe(false);
  });

  it("preserves the channel and publisher when resuming an interrupted install", async () => {
    const host = await installation();
    await host.save("edge", "sanctum-example");

    await host.run();

    expect((await host.commands()).map(({ args }) => args)).toContainEqual([
      "pull",
      "ghcr.io/sanctum-example/sanctum-manager:edge",
    ]);
    expect(await host.settings()).toContain(
      "SANCTUM_IMAGE_OWNER=sanctum-example",
    );
  });

  it("refuses a channel change when an interrupted install has no manager yet", async () => {
    const host = await installation();
    await host.save();

    await expect(host.run(["--channel", "stable"])).rejects.toThrow(
      "does not change it",
    );

    expect(await host.changes()).toBe("");
    expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
  });

  it("starts only the selected manager image despite shell and working directory settings", async () => {
    const host = await installation();
    await writeFile(join(host.dir, "../.env"), "SANCTUM_CHANNEL=edge\n");

    await host.run(["--channel", "stable"], {
      SANCTUM_CHANNEL: "edge",
      SANCTUM_MANAGER_IMAGE: "sanctum.example/other:edge",
      COMPOSE_PROJECT_NAME: "another-project",
      COMPOSE_PROFILES: "dev",
    });

    const command = (await host.commands()).find(({ args }) =>
      args.includes("up"),
    )!;
    expect(command.channel).toBe("stable");
    expect(command.image).toBe("ghcr.io/meetsanctum/sanctum-manager:stable");
    expect(command.args).toEqual([
      "compose",
      "--project-name",
      "sanctum",
      "--env-file",
      join(host.dir, ".env"),
      "-f",
      join(host.dir, "compose.yml"),
      "up",
      "-d",
      "manager",
    ]);
    expect(await host.settings()).toContain("SANCTUM_CHANNEL=stable");
  });

  it("keeps settings after a failed start so the same install can resume", async () => {
    const host = await installation();

    await expect(
      host.run(["--channel", "edge"], { INSTALL_TEST_FAIL_START: "1" }),
    ).rejects.toThrow();
    await host.run();

    expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
  });

  it("counts health check time toward the 15 minute startup deadline", async () => {
    const host = await installation();

    const result = await host
      .runShell(
        `running() { SECONDS=$((SECONDS + 500)); return 1; }
sleep() { :; }
wait_until_running`,
        [],
      )
      .catch((error: { stdout: string; stderr: string }) => error);

    expect(result.stderr).toContain("did not start within 15 minutes");
    expect(result.stdout.split(".").length).toBeLessThan(5);
  });
});
