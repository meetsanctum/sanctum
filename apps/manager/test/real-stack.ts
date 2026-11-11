import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { PackagesState } from "../src/update/packages.js";

// A stack of the real images a host runs, for the tests that need them: a manager
// from its own image, and the core it starts from its own, each app staged from
// it, with what those tests all do to it.

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "../../..");

async function run(command: string, args: string[], env: object = {}) {
  const { stdout } = await execFile(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

const docker = (...args: string[]) => run("docker", args);

export function realStack(prefix: string, coreEnv: readonly string[] = []) {
  const stack = `${prefix}-${randomBytes(3).toString("hex")}`;
  const name = (part: string) => `sanctum-${stack}-${part}`;
  const dataVolume = name("manager-data");
  const coreImage = `${name("core")}:real`;
  const nextCoreImage = `${name("core")}:next`;

  const buildOptions = [
    "build",
    "--quiet",
    "--provenance=false",
    "--label",
    `sanctum.stack=${stack}`,
  ];

  const build = (dockerfile: string, tag: string) =>
    docker(...buildOptions, "-f", dockerfile, "-t", tag, ".");

  // An image on top of another, from a Dockerfile in a string.
  const buildOnTop = (tag: string, dockerfile: string) =>
    new Promise<void>((done, fail) => {
      const child = execFileCallback(
        "docker",
        [...buildOptions, "-t", tag, "-"],
        { cwd: root },
        (error) => (error ? fail(error) : done()),
      );
      child.stdin?.end(dockerfile);
    });

  async function freePort() {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    await new Promise((done) => server.close(done));
    return port;
  }

  async function waitFor<T>(what: string, check: () => Promise<T | undefined>) {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const found = await check().catch(() => undefined);
      if (found !== undefined) return found;
      await new Promise((done) => setTimeout(done, 1000));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  // As deploy/compose.yml starts it, without what only a host has: mDNS and the
  // host's network. A stack's settings choose its core's image and port.
  async function startManager(image: string, port: number) {
    await docker(
      "run",
      "--detach",
      "--name",
      name("manager"),
      "--label",
      `sanctum.stack=${stack}`,
      "--env",
      `SANCTUM_STACK=${stack}`,
      "--env",
      `SANCTUM_STACK_CORE_IMAGE=${image}`,
      "--env",
      `SANCTUM_STACK_CORE_PORT=${port}`,
      "--env",
      `SANCTUM_STACK_CORE_ENV=${["CORE_PLAIN_HTTP=true", ...coreEnv].join(";")}`,
      "--env",
      "SANCTUM_CHANNEL=dev",
      "--env",
      "MANAGER_ANNOUNCE=false",
      "--env",
      "MANAGER_HOST_DEV_DIR=/dev",
      "--volume",
      "/var/run/docker.sock:/var/run/docker.sock",
      "--volume",
      `${dataVolume}:/data`,
      "--volume",
      `${name("core-data")}:/core-data`,
      "--volume",
      `${name("manager-socket")}:/run/sanctum`,
      `${name("manager")}:real`,
    );
  }

  const readState = async () =>
    JSON.parse(
      await docker("exec", name("manager"), "cat", "/data/packages.json"),
    ) as PackagesState;

  // Says what the manager did if they don't come, since the test's end removes it.
  const stagedFrom = (image: string) =>
    waitFor(`packages from ${image}`, async () => {
      const state = await readState();
      return state.image === image ? state : undefined;
    }).catch(async (error: Error) => {
      const logs = await managerLogs("0").catch(String);
      throw new Error(`${error.message}\nThe manager's log:\n${logs}`);
    });

  // Claims the home from inside the core's container, where the login's
  // dependencies are, as `pnpm dev:seed` does, and prints the session's token.
  const claimScript = `
    import { keyStretching } from "@meetsanctum/auth-protocol";
    import * as opaque from "@serenity-kit/opaque";
    const password = "a-test-stack-only";
    const call = async (path, body) => {
      const response = await fetch("http://127.0.0.1:4100" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(path + ": " + response.status);
      return response.json();
    };
    await opaque.ready;
    const { clientRegistrationState, registrationRequest } =
      opaque.client.startRegistration({ password });
    const { registrationId, registrationResponse } = await call(
      "/api/auth/claim/start",
      { username: "test", registrationRequest },
    );
    const { registrationRecord } = opaque.client.finishRegistration({
      clientRegistrationState,
      registrationResponse,
      password,
      keyStretching: keyStretching.profile,
    });
    const { token } = await call("/api/auth/claim/finish", {
      registrationId,
      registrationRecord,
      keyStretching: keyStretching.version,
      person: { name: "Test", colour: "#c5cdac" },
      client: { name: "packages test", platform: "macos" },
    });
    console.log(token);
  `;

  const imageId = (image: string) =>
    docker("image", "inspect", "-f", "{{.Id}}", image);

  const managerLogs = (since: string) =>
    run("sh", ["-c", `docker logs --since ${since} ${name("manager")} 2>&1`]);

  // The manager's API, through its socket, from inside its container.
  async function api(method: string, path: string, body?: unknown) {
    const answer = await docker(
      "exec",
      name("manager"),
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
    const { status, text } = JSON.parse(answer) as {
      status: number;
      text: string;
    };
    return { status, body: (text ? JSON.parse(text) : null) as never };
  }

  // Claims the home, and answers with the session's token.
  const claim = () =>
    docker(
      "exec",
      "--workdir",
      "/app",
      name("core"),
      "node",
      "--no-warnings",
      "--input-type=module",
      "-e",
      claimScript,
    );

  async function createVolumes() {
    for (const part of ["manager-data", "core-data", "manager-socket"]) {
      await docker(
        "volume",
        "create",
        "--label",
        `sanctum.stack=${stack}`,
        // The manager takes over the volumes it manages only with this label.
        ...(part === "manager-data" ? [] : ["--label", "sanctum.managed=true"]),
        name(part),
      );
    }
  }

  return {
    api,
    build,
    buildOnTop,
    claim,
    coreImage,
    createVolumes,
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
  };
}
