import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createLanHolders,
  holderName,
  lanNetworkName,
  type LanHolders,
} from "../src/apps/lan.js";
import { createDockerClient } from "../src/docker.js";

// An app's network of its own on real Docker and its kernel's nftables: its
// holder, its rules as the manager loads them, and what an app sharing that
// network can and can't reach. A device stands in on the app's network, where
// the manager's checks of the home's network would otherwise leave it out.

const execFile = promisify(execFileCallback);
const docker = async (...args: string[]) =>
  (
    await execFile("docker", args, { maxBuffer: 16 * 1024 * 1024 })
  ).stdout.trim();

const tag = randomBytes(3).toString("hex");
const app = `test.lan${tag}`;
const image = `sanctum-lan-test:${tag}`;
const device = `sanctum-lan-test-device-${tag}`;
const other = `sanctum-lan-test-other-${tag}`;
const ticking = `sanctum-lan-test-ticking-${tag}`;

let holders: LanHolders;
let holder: string;
let count = 0;
const policy = (addresses: string[]) => ({
  core: "test",
  count: ++count,
  addresses,
  ports: [6053],
});

const addressOf = (container: string) =>
  docker(
    "inspect",
    "-f",
    `{{(index .NetworkSettings.Networks "${lanNetworkName(app)}").IPAddress}}`,
    container,
  );

// What an app in the holder's network, with no capabilities, gets to.
async function probe(script: string) {
  return docker(
    "run",
    "--rm",
    "--network",
    `container:${holder}`,
    "--cap-drop",
    "ALL",
    "alpine:latest",
    "sh",
    "-c",
    script,
  );
}

const reaches = (address: string, port: number) =>
  probe(`nc -z -w 2 ${address} ${port} && echo yes || echo no`);

describe("an app's network of its own on real Docker", () => {
  beforeAll(async () => {
    await new Promise<void>((done, fail) => {
      const child = execFileCallback(
        "docker",
        ["build", "--quiet", "-t", image, "-"],
        (error) => (error ? fail(error) : done()),
      );
      child.stdin?.end("FROM alpine:latest\nRUN apk add --no-cache nftables\n");
    });
    await docker("pull", "--quiet", "alpine:latest");
    holders = createLanHolders({
      docker: createDockerClient(),
      image: async () => image,
      run: "test",
      reachable: () => true,
      log: () => undefined,
    });
    holder = (await holders.make(app, policy([]))).id;
    await holders.settle(app);
    const serving = (name: string, script: string) =>
      docker(
        "run",
        "--detach",
        "--name",
        name,
        "--network",
        lanNetworkName(app),
        "alpine:latest",
        "sh",
        "-c",
        script,
      );
    const listen = (port: number) =>
      `while true; do echo hi | nc -l -p ${port}; done`;
    await serving(device, `${listen(6053)} & ${listen(80)}`);
    await serving(other, listen(6053));
  }, 300_000);

  afterAll(async () => {
    await docker("rm", "--force", device, other, ticking).catch(() => "");
    await holders?.remove(app).catch(() => undefined);
    await docker("rmi", "--force", image).catch(() => "");
  }, 120_000);

  it("holds the app's network with no capabilities and no IPv6", async () => {
    const inspected = JSON.parse(
      await docker("inspect", holderName(app)),
    )[0] as {
      HostConfig: { CapDrop: string[]; RestartPolicy: { Name: string } };
      State: { Running: boolean };
    };

    expect(inspected.State.Running).toBe(true);
    expect(inspected.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(inspected.HostConfig.RestartPolicy.Name).toBe("no");
    expect(
      await probe("cat /proc/sys/net/ipv6/conf/all/disable_ipv6; ip -6 addr"),
    ).toBe("1");
  });

  it("lets the app reach its devices on its port, and nothing else", async () => {
    const address = await addressOf(device);
    const otherAddress = await addressOf(other);
    expect(await reaches(address, 6053)).toBe("no");

    await holders.apply(app, {
      ...policy([address]),
      manager: "test",
      holder,
    });

    expect(await reaches(address, 6053)).toBe("yes");
    // Another port of the device, another container on its network, the
    // network's gateway and the internet.
    expect(await reaches(address, 80)).toBe("no");
    expect(await reaches(otherAddress, 6053)).toBe("no");
    expect(await reaches(address.replace(/\.\d+$/, ".1"), 80)).toBe("no");
    expect(await reaches("1.1.1.1", 80)).toBe("no");
    // Docker's resolver, over UDP and over TCP.
    expect(
      await probe(
        "nslookup -timeout=2 example.com >/dev/null 2>&1 && echo yes || echo no",
      ),
    ).toBe("no");
    expect(await reaches("127.0.0.11", 53)).toBe("no");
  });

  it("cuts a connection open to an address it takes away", async () => {
    const address = await addressOf(device);
    // A device that says something every 100 ms on one open connection.
    const sayer = `sanctum-lan-test-sayer-${tag}`;
    await docker(
      "run",
      "--detach",
      "--name",
      sayer,
      "--network",
      lanNetworkName(app),
      "alpine:latest",
      "sh",
      "-c",
      "(while true; do echo tick; sleep 0.1; done) | nc -l -p 6053",
    );
    const sayerAddress = await addressOf(sayer);
    await holders.apply(app, {
      ...policy([address, sayerAddress]),
      manager: "test",
      holder,
    });
    await docker(
      "run",
      "--detach",
      "--name",
      ticking,
      "--network",
      `container:${holder}`,
      "--cap-drop",
      "ALL",
      "alpine:latest",
      "nc",
      sayerAddress,
      "6053",
    );
    const ticks = async () =>
      (await docker("logs", ticking)).split("\n").filter(Boolean).length;
    await expect.poll(ticks, { timeout: 10_000 }).toBeGreaterThan(3);

    await holders.apply(app, {
      ...policy([address]),
      manager: "test",
      holder,
    });
    await new Promise((done) => setTimeout(done, 500));
    const cut = await ticks();
    await new Promise((done) => setTimeout(done, 1_500));

    expect(await ticks()).toBe(cut);
    await docker("rm", "--force", sayer).catch(() => "");
  });

  it("goes with its network", async () => {
    await docker("rm", "--force", device, other, ticking).catch(() => "");

    await holders.remove(app);

    await expect(docker("inspect", holderName(app))).rejects.toThrow();
    await expect(
      docker("network", "inspect", lanNetworkName(app)),
    ).rejects.toThrow();
  });
});
