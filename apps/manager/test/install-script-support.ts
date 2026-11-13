import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// What the installer's tests share: the script run with its real entry point
// against a stand-in Docker, in a folder of its own.

const execFile = promisify(execFileCallback);
const scriptPath = resolve(import.meta.dirname, "../../../deploy/install.sh");
const composePath = resolve(import.meta.dirname, "../../../deploy/compose.yml");
const folders: string[] = [];

// What the stand-in Docker holds. Each is its manager's by label unless
// Compose made it, and a development stack's where it names one.
type Held = { name: string; stack?: string; compose?: boolean };
export type Docker = {
  containers?: (Held & { image: string })[];
  volumes?: Held[];
  networks?: Held[];
  // Sanctum's own images.
  images?: { id: string; stack?: string }[];
  // Images a container outside Sanctum runs.
  usedElsewhere?: string[];
};
export type Command = {
  tool?: string;
  args: string[];
  channel?: string;
  owner?: string;
  image?: string;
};

// Each test file clears these away after every test.
export async function removeInstallations() {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
}

// Run the installer with its real entry point and Docker commands, replacing
// machine checks and host settings so these tests need neither root nor Docker.
export async function installation() {
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
import { appendFileSync, readFileSync } from "node:fs";
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
const asked = readFileSync(env.INSTALL_TEST_COMMANDS, "utf8").trim().split("\\n");
if (env.INSTALL_TEST_STOPS_AT && asked.some((line) => JSON.parse(line).args.join(" ").includes(env.INSTALL_TEST_STOPS_AT))) {
  console.error("Docker stopped answering");
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
