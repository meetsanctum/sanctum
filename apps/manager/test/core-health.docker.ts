import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHostAuthority } from "../src/certificates/host-ca.js";
import { coreContainerOptions, corePort } from "../src/core-container.js";
import { createDockerClient } from "../src/docker.js";

// The core's health check on real Docker: the check the manager gives the
// core's container, run by Docker against HTTPS in the image the core's is
// built on, with the init process the manager asks for. BusyBox's wget leaves
// the helper it starts for HTTPS behind at every check, and only real
// processes show whether something takes it in.

const execFile = promisify(execFileCallback);
const docker = async (...args: string[]) =>
  (
    await execFile("docker", args, { maxBuffer: 16 * 1024 * 1024 })
  ).stdout.trim();

const name = `sanctum-core-health-test-${randomBytes(3).toString("hex")}`;
// Docker keeps a container's last five checks.
const checks = 5;

// Answers anything over HTTPS on the core's port, as the core answers its
// health route.
const serving = `
  require("node:https")
    .createServer(
      { key: process.env.TEST_KEY, cert: process.env.TEST_CERTIFICATE },
      (request, response) => response.end('{"status":"ok"}'),
    )
    .listen(${corePort});
  process.on("SIGTERM", () => process.exit(0));
`;

type Inspected = {
  State: { Health: { Status: string; Log: Array<{ ExitCode: number }> } };
  HostConfig: { Init: boolean | null };
};

const inspect = async () =>
  (JSON.parse(await docker("inspect", name)) as Inspected[])[0]!;

let dataDir: string;

describe("the core's health check on real Docker", () => {
  beforeAll(async () => {
    const dockerfile = await readFile(
      resolve(import.meta.dirname, "../../core/Dockerfile"),
      "utf8",
    );
    const image = /^FROM (\S+) AS runtime$/m.exec(dockerfile)![1]!;
    await docker("pull", "--quiet", image);

    // A certificate from a host CA, as the core serves one.
    dataDir = await mkdtemp(join(tmpdir(), "sanctum-core-health-"));
    const authority = await createHostAuthority({
      dataDir,
      hostId: randomUUID(),
      names: () => ({ dns: ["localhost"], ips: ["127.0.0.1"] }),
      log: () => undefined,
    });
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const { certificate } = await authority.sign(
      publicKey.export({ type: "spki", format: "pem" }) as string,
    );

    const core = coreContainerOptions(image);
    const { id } = await createDockerClient().createContainer({
      name,
      Image: image,
      Cmd: ["node", "-e", serving],
      Env: [
        `TEST_KEY=${privateKey.export({ type: "pkcs8", format: "pem" }) as string}`,
        `TEST_CERTIFICATE=${certificate}`,
      ],
      // The core's own check, only sooner.
      Healthcheck: { ...core.Healthcheck, Interval: 1_000_000_000 },
      HostConfig: { Init: core.HostConfig!.Init },
    });
    await docker("start", id);
  }, 300_000);

  afterAll(async () => {
    await docker("rm", "--force", name).catch(() => "");
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }, 120_000);

  it("leaves no process behind, check after check", async () => {
    const deadline = Date.now() + 60_000;
    let health = (await inspect()).State.Health;
    while (health.Log.length < checks && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 500));
      health = (await inspect()).State.Health;
    }

    expect(health.Status).toBe("healthy");
    expect(health.Log.map((check) => check.ExitCode)).toEqual(
      Array.from({ length: checks }, () => 0),
    );

    // Each check's wget started its helper, and none is left as a zombie,
    // waiting for a parent that never asks.
    const processes = (await docker("exec", name, "ps", "-o", "stat,comm"))
      .split("\n")
      .slice(1)
      .map((line) => line.trim());
    expect(processes.filter((line) => line.startsWith("Z"))).toEqual([]);
  });
});
