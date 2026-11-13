import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const scriptPath = resolve(import.meta.dirname, "../../../deploy/install.sh");
const composePath = resolve(import.meta.dirname, "../../../deploy/compose.yml");
const folders: string[] = [];

// What the stand-in Docker holds. Each is its manager's by label unless
// Compose made it, and a development stack's where it names one.
type Held = { name: string; stack?: string; compose?: boolean };
type Docker = {
  containers?: (Held & { image: string })[];
  volumes?: Held[];
  networks?: Held[];
  // Sanctum's own images.
  images?: { id: string; stack?: string }[];
  // Images a container outside Sanctum runs.
  usedElsewhere?: string[];
};
type Command = {
  tool?: string;
  args: string[];
  channel?: string;
  owner?: string;
  image?: string;
};

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
const format = args.join(" ");
const held = JSON.parse(env.INSTALL_TEST_DOCKER || "{}");
const isManagerLookup = (args[0] === "inspect" && args.length === 2) ||
  (args[0] === "container" && args[1] === "ls" && format.includes("name=^/sanctum-manager$"));
if (isManagerLookup && env.INSTALL_TEST_FAIL_MANAGER_LOOKUP) {
  console.error("Manager lookup failed");
  process.exit(1);
}
if (args[0] === "container" && isManagerLookup) {
  if (env.INSTALL_TEST_MANAGER) console.log("sanctum-manager");
  process.exit(0);
}
if (env.INSTALL_TEST_FAIL_COMMAND && format.includes(env.INSTALL_TEST_FAIL_COMMAND)) {
  console.error("Docker query failed");
  process.exit(1);
}
if (args[0] === "info" && env.INSTALL_TEST_DOCKER_STOPPED) process.exit(1);
if (args[1] === "ls" && args[0] !== "image") {
  const label = args[args.indexOf("--filter") + 1].replace("label=", "");
  const unstacked = format.includes('{{if .Label "sanctum.stack"}}{{else}}');
  for (const each of held[args[0] + "s"] ?? []) {
    const labelled = each.compose ? "com.docker.compose.project=sanctum" : "sanctum.managed=true";
    if (label === labelled) console.log(each.stack && unstacked ? "" : each.name);
  }
}
if (args[0] === "image" && args[1] === "ls") {
  for (const each of held.images ?? []) console.log(each.id);
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect" && format.includes("sanctum.stack")) {
  console.log((held.images ?? []).find((each) => each.id === args.at(-1))?.stack ?? "");
  process.exit(0);
}
if (args[0] === "ps" && (held.usedElsewhere ?? []).includes(format.split("ancestor=")[1])) console.log("in-use");
if (args[0] === "volume" && args[1] === "inspect") console.log(env.INSTALL_TEST_VOLUME);
if (args[0] === "inspect" && format.includes("{{.Image}}")) {
  console.log((held.containers ?? []).find((each) => each.name === args.at(-1))?.image ?? "");
  process.exit(0);
}
if (args[0] === "inspect") {
  if (!env.INSTALL_TEST_MANAGER) process.exit(1);
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
  // What the script runs on the machine itself, noted beside Docker's.
  for (const tool of ["losetup", "systemctl"]) {
    await writeFile(
      join(bin, tool),
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.INSTALL_TEST_COMMANDS, JSON.stringify({ tool: "${tool}", args }) + "\\n");
if (args[0] === "-j" && basename(args[1]) === process.env.INSTALL_TEST_ATTACHED) console.log("/dev/loop7");
`,
      { mode: 0o755 },
    );
  }
  const terminal = join(folder, "terminal");
  const sleepSettings = join(folder, "logind.conf.d", "sanctum.conf");
  const volume = join(folder, "volume");
  await mkdir(join(volume, "images"), { recursive: true });
  const definitions = (await readFile(scriptPath, "utf8")).replace(
    /\nmain "\$@"\s*$/,
    "\n",
  );
  const setup = `${definitions}
dir="$INSTALL_TEST_DIR"
script=""
terminal="$INSTALL_TEST_TERMINAL"
sleep_settings="$INSTALL_TEST_SLEEP_SETTINGS"
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
        INSTALL_TEST_TERMINAL: terminal,
        INSTALL_TEST_SLEEP_SETTINGS: sleepSettings,
        INSTALL_TEST_VOLUME: volume,
        ...env,
      },
    });

  return {
    dir,
    sleepSettings,
    imagesFolder: join(volume, "images"),
    run: (args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
      runShell('main "$@"', args, env),
    // Removes with the stand-in Docker holding these, and a person typing
    // the answer, or no terminal where there is none.
    uninstall: async (
      docker: Docker,
      options: {
        answer?: string;
        args?: string[];
        env?: NodeJS.ProcessEnv;
      } = {},
    ) => {
      if (options.answer !== undefined) {
        await writeFile(terminal, `${options.answer}\n`);
      }
      return runShell('main "$@"', ["--uninstall", ...(options.args ?? [])], {
        INSTALL_TEST_DOCKER: JSON.stringify(docker),
        ...(docker.containers?.some(({ name }) => name === "sanctum-manager")
          ? { INSTALL_TEST_MANAGER: "running" }
          : {}),
        ...options.env,
      });
    },
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
        .map((line) => JSON.parse(line) as Command),
  };
}

// A home that runs: the manager from Compose, what it made, and beside it a
// development stack's on the same Docker.
const home: Docker = {
  containers: [
    { name: "sanctum-manager", image: "manager-image", compose: true },
    { name: "sanctum-manager-updater", image: "manager-image" },
    { name: "sanctum-core", image: "core-image" },
    { name: "sanctum-app-sanctum.example", image: "node-image" },
    { name: "sanctum-mosquitto", image: "mosquitto-image" },
    { name: "sanctum-tree-core", image: "stack-core-image", stack: "tree" },
  ],
  volumes: [
    { name: "sanctum-manager-data", compose: true },
    { name: "sanctum-core-data" },
    { name: "sanctum-app-data-sanctum.example" },
    { name: "sanctum-tree-core-data", stack: "tree" },
  ],
  networks: [{ name: "sanctum" }, { name: "sanctum-tree", stack: "tree" }],
  images: [
    { id: "manager-image" },
    { id: "core-image" },
    { id: "previous-core-image" },
    { id: "stack-core-image", stack: "tree" },
  ],
  usedElsewhere: ["node-image"],
};

// What changes the machine: everything but questions.
function changing(commands: Command[]) {
  return commands
    .filter(
      ({ tool, args }) =>
        tool === "systemctl" ||
        (tool === "losetup" && args[0] === "-d") ||
        (!tool &&
          (["stop", "rm"].includes(args[0]!) ||
            (["volume", "network", "image"].includes(args[0]!) &&
              args[1] === "rm"))),
    )
    .map(({ tool, args }) => [tool ?? "docker", ...args].join(" "));
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
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

// A removal asks the stand-in Docker some forty questions, each a process of
// its own, which takes a slow machine longer than a test's five seconds.
describe("host installer, removing", { timeout: 30_000 }, () => {
  it("removes what Sanctum made, in order, and nothing of a development stack", async () => {
    const host = await installation();
    await host.save("stable");
    await writeFile(join(host.imagesFolder, "sanctum.example.img"), "");
    await writeFile(join(host.imagesFolder, "sanctum.weather.img"), "");

    const { stdout } = await host.uninstall(home, {
      answer: "remove",
      env: { INSTALL_TEST_ATTACHED: "sanctum.example.img" },
    });

    expect(stdout).toContain("your home's data");
    expect(stdout).toContain("Sanctum is removed");
    expect(changing(await host.commands())).toEqual([
      "docker stop sanctum-manager-updater",
      "docker stop sanctum-manager",
      "docker rm -f -v sanctum-manager-updater sanctum-core sanctum-app-sanctum.example sanctum-mosquitto sanctum-manager",
      "losetup -d /dev/loop7",
      "docker volume rm sanctum-core-data sanctum-app-data-sanctum.example sanctum-manager-data",
      "docker network rm sanctum",
      "docker image rm -f core-image",
      "docker image rm -f manager-image",
      "docker image rm -f mosquitto-image",
      "docker image rm -f previous-core-image",
    ]);
    expect(await exists(host.dir)).toBe(false);
  });

  it("asks only about the images in Sanctum's own volume", async () => {
    const host = await installation();
    await host.save();
    await writeFile(join(host.imagesFolder, "sanctum.example.img"), "");

    await host.uninstall(home, { answer: "remove" });

    const asked = (await host.commands()).filter(
      ({ tool }) => tool === "losetup",
    );
    expect(asked.map(({ args }) => args)).toEqual([
      [
        "-j",
        join(host.imagesFolder, "sanctum.example.img"),
        "-n",
        "-O",
        "NAME",
      ],
    ]);
  });

  it("leaves everything when the answer is anything but remove", async () => {
    const host = await installation();
    await host.save();

    await expect(host.uninstall(home, { answer: "yes" })).rejects.toThrow(
      "Sanctum stays. Nothing was changed.",
    );

    expect(changing(await host.commands())).toEqual([]);
    expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
  });

  it("refuses without a terminal to ask on", async () => {
    const host = await installation();
    await host.save();

    await expect(host.uninstall(home)).rejects.toThrow("add --yes");

    expect(changing(await host.commands())).toEqual([]);
  });

  it("removes without asking when told to", async () => {
    const host = await installation();
    await host.save();

    const { stdout } = await host.uninstall(home, { args: ["--yes"] });

    expect(stdout).toContain("with your home's data");
    expect(stdout).not.toContain("Type");
    expect(changing(await host.commands())).toContain(
      "docker network rm sanctum",
    );
    expect(await exists(host.dir)).toBe(false);
  });

  it("refuses a manager set up another way", async () => {
    const host = await installation();
    await host.save();

    await expect(
      host.uninstall(home, {
        args: ["--yes"],
        env: { INSTALL_TEST_COMPOSE: "/another/compose.yml" },
      }),
    ).rejects.toThrow("set up another way");

    expect(changing(await host.commands())).toEqual([]);
  });

  it("does not bypass ownership checks when finding the manager fails", async () => {
    const host = await installation();
    await host.save();

    await expect(
      host.uninstall(home, {
        args: ["--yes"],
        env: { INSTALL_TEST_FAIL_MANAGER_LOOKUP: "1" },
      }),
    ).rejects.toThrow("Manager lookup failed");

    expect(changing(await host.commands())).toEqual([]);
    expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
  });

  it("refuses what a manager left behind with no installation of its own", async () => {
    const host = await installation();

    await expect(
      host.uninstall(
        { volumes: [{ name: "sanctum-core-data" }] },
        { args: ["--yes"] },
      ),
    ).rejects.toThrow("set up another way");

    expect(changing(await host.commands())).toEqual([]);
  });

  it("refuses a home on the dev channel", async () => {
    const host = await installation();
    await host.save("dev");

    await expect(host.uninstall(home, { args: ["--yes"] })).rejects.toThrow(
      "on the dev channel",
    );

    expect(changing(await host.commands())).toEqual([]);
  });

  it("says so where there is no Sanctum, beside a development stack's", async () => {
    const host = await installation();

    const { stdout } = await host.uninstall({
      containers: [
        { name: "sanctum-tree-core", image: "stack-core-image", stack: "tree" },
      ],
      volumes: [{ name: "sanctum-tree-core-data", stack: "tree" }],
    });

    expect(stdout).toContain("Sanctum is not installed on this machine");
    expect(changing(await host.commands())).toEqual([]);
  });

  it("finishes a removal that was cut short", async () => {
    const host = await installation();
    await host.save();

    await host.uninstall(
      { volumes: [{ name: "sanctum-manager-data", compose: true }] },
      { answer: "remove" },
    );

    expect(changing(await host.commands())).toEqual([
      "docker volume rm sanctum-manager-data",
    ]);
    expect(await exists(host.dir)).toBe(false);
  });

  it("remembers service images after an interruption removed their containers", async () => {
    const host = await installation();
    await host.save();
    const service: Docker = {
      containers: [{ name: "sanctum-mosquitto", image: "mosquitto-image" }],
      volumes: [{ name: "sanctum-core-data" }],
    };

    await expect(
      host.uninstall(service, {
        args: ["--yes"],
        env: { INSTALL_TEST_FAIL_COMMAND: "volume rm" },
      }),
    ).rejects.toThrow();

    expect(changing(await host.commands())).toContain(
      "docker rm -f -v sanctum-mosquitto",
    );
    await host.uninstall({ volumes: service.volumes }, { args: ["--yes"] });

    expect(changing(await host.commands())).toContain(
      "docker image rm -f mosquitto-image",
    );
    expect(await exists(host.dir)).toBe(false);
  });

  it("waits for Docker rather than removing half", async () => {
    const host = await installation();
    await host.save();

    await expect(
      host.uninstall(home, {
        args: ["--yes"],
        env: { INSTALL_TEST_DOCKER_STOPPED: "1" },
      }),
    ).rejects.toThrow("Docker, which is not running");

    expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
  });

  it.each(["container", "volume", "network"])(
    "keeps its installation files when listing managed %ss fails",
    async (kind) => {
      const host = await installation();
      await host.save();

      await expect(
        host.uninstall(home, {
          args: ["--yes"],
          env: {
            INSTALL_TEST_FAIL_COMMAND: `${kind} ls ${kind === "container" ? "-a " : ""}--filter label=sanctum.managed=true`,
          },
        }),
      ).rejects.toThrow("Docker query failed");

      expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
      expect(await exists(join(host.dir, "compose.yml"))).toBe(true);
    },
  );

  it("does not mistake a failed ownership query for no installation", async () => {
    const host = await installation();

    await expect(
      host.uninstall(
        {},
        {
          args: ["--yes"],
          env: {
            INSTALL_TEST_FAIL_COMMAND: "container ls -a --filter",
          },
        },
      ),
    ).rejects.toThrow("Docker query failed");

    expect(changing(await host.commands())).toEqual([]);
  });

  it.each(["image ls", "image inspect", "inspect -f {{.Image}}"])(
    "keeps its installation files when collecting images fails at %s",
    async (command) => {
      const host = await installation();
      await host.save();

      await expect(
        host.uninstall(home, {
          args: ["--yes"],
          env: { INSTALL_TEST_FAIL_COMMAND: command },
        }),
      ).rejects.toThrow("Docker query failed");

      expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
      expect((await host.commands()).some(({ args }) => args[0] === "rm")).toBe(
        false,
      );
    },
  );

  it("does not delete an image when it cannot check who uses it", async () => {
    const host = await installation();
    await host.save();

    await expect(
      host.uninstall(home, {
        args: ["--yes"],
        env: { INSTALL_TEST_FAIL_COMMAND: "ps -aq --filter ancestor=" },
      }),
    ).rejects.toThrow("Docker query failed");

    expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
    expect(
      (await host.commands()).some(
        ({ args }) => args[0] === "image" && args[1] === "rm",
      ),
    ).toBe(false);
  });

  it("lets a laptop sleep again, and only one it kept awake", async () => {
    const laptop = await installation();
    await laptop.save();
    await mkdir(join(laptop.sleepSettings, ".."));
    await writeFile(laptop.sleepSettings, "[Login]\n");
    const other = await installation();
    await other.save();

    await laptop.uninstall(home, { args: ["--yes"] });
    await other.uninstall(home, { args: ["--yes"] });

    expect(
      changing(await laptop.commands()).filter((each) =>
        each.startsWith("systemctl"),
      ),
    ).toEqual([
      "systemctl unmask --quiet sleep.target suspend.target hibernate.target hybrid-sleep.target",
      "systemctl kill --signal=HUP systemd-logind",
    ]);
    expect(await exists(laptop.sleepSettings)).toBe(false);
    expect(
      (await other.commands()).some(({ tool }) => tool === "systemctl"),
    ).toBe(false);
  });

  it("keeps a folder that holds anything else", async () => {
    const host = await installation();
    await host.save();
    await writeFile(join(host.dir, "notes.txt"), "mine");

    await host.uninstall(home, { args: ["--yes"] });

    expect(await exists(join(host.dir, "notes.txt"))).toBe(true);
    expect(await exists(join(host.dir, "compose.yml"))).toBe(false);
    expect(await exists(join(host.dir, ".env"))).toBe(false);
  });

  it("takes no channel when removing, and no --yes when installing", async () => {
    const host = await installation();

    await expect(
      host.run(["--uninstall", "--channel", "edge"]),
    ).rejects.toThrow("Usage");
    await expect(host.run(["--yes"])).rejects.toThrow("Usage");

    expect(await host.commands()).toEqual([]);
  });
});
