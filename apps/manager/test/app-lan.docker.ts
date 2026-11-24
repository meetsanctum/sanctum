import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
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

// The base of the manager's own image.
const runtimeBase = /^FROM (\S+) AS runtime$/m.exec(
  readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"),
)![1]!;

const tag = randomBytes(3).toString("hex");
const app = `test.lan${tag}`;
const image = `sanctum-lan-test:${tag}`;
const device = `sanctum-lan-test-device-${tag}`;
const other = `sanctum-lan-test-other-${tag}`;
const ticking = `sanctum-lan-test-ticking-${tag}`;
const listener = `sanctum-lan-test-listener-${tag}`;
const sayer = `sanctum-lan-test-sayer-${tag}`;

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
      // nft as the manager's own image has it, which holders and helpers
      // run from.
      child.stdin?.end(
        `FROM ${runtimeBase}\nRUN apk add --no-cache nftables\n`,
      );
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
    // Its ports, and a range's ends and the ports either side of them, each
    // listening, so that what isn't reached is what the rules drop.
    await serving(
      device,
      [6053, 80, 49_999, 50_000, 50_005, 50_010, 50_011]
        .map(listen)
        .join(" & "),
    );
    await serving(other, listen(6053));
  }, 300_000);

  afterAll(async () => {
    await docker(
      "rm",
      "--force",
      device,
      other,
      ticking,
      listener,
      sayer,
    ).catch(() => "");
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

  it("drops connections initiated by an allowed device from an allowed port", async () => {
    const address = await addressOf(device);
    const holderAddress = await addressOf(holderName(app));
    await holders.apply(app, {
      ...policy([address]),
      ports: [6053, 6054],
      manager: "test",
      holder,
    });
    await docker(
      "run",
      "--detach",
      "--name",
      listener,
      "--network",
      `container:${holder}`,
      "--cap-drop",
      "ALL",
      "alpine:latest",
      "sh",
      "-c",
      "nc -l -p 12345",
    );
    // The listener is ready even while the firewall rejects its traffic.
    await expect
      .poll(() =>
        docker(
          "exec",
          listener,
          "sh",
          "-c",
          "cat /proc/net/tcp /proc/net/tcp6 | grep -c ':3039 ' || true",
        ),
      )
      .toBe("1");

    expect(
      await docker(
        "exec",
        device,
        "sh",
        "-c",
        `nc -z -w 2 -p 6054 ${holderAddress} 12345 && echo yes || echo no`,
      ),
    ).toBe("no");
    await docker("rm", "--force", listener);
  });

  it("cuts a connection open to an address it takes away", async () => {
    const address = await addressOf(device);
    // A device that says something every 100 ms on one open connection.
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

  it("lets the app reach its devices on a range of ports, both ends included, and not a port past either", async () => {
    const address = await addressOf(device);
    await holders.apply(app, {
      ...policy([address]),
      ports: [6053, [50_000, 50_010]],
      manager: "test",
      holder,
    });

    for (const port of [6053, 50_000, 50_005, 50_010]) {
      expect(await reaches(address, port), `port ${port}`).toBe("yes");
    }
    for (const port of [80, 49_999, 50_011]) {
      expect(await reaches(address, port), `port ${port}`).toBe("no");
    }
    // As nft lists them: the range as one, and the rules that use the sets.
    const listed = await docker(
      "run",
      "--rm",
      "--network",
      `container:${holder}`,
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_ADMIN",
      image,
      "nft",
      "-j",
      "list",
      "table",
      "inet",
      "sanctum",
    );
    const { nftables } = JSON.parse(listed) as {
      nftables: Record<
        string,
        { name?: string; elem?: unknown; expr?: unknown }
      >[];
    };
    expect(
      nftables.find((each) => each.set?.name === "reachports")?.set?.elem,
    ).toEqual([6053, { range: [50_000, 50_010] }]);
    const rules = nftables.flatMap((each) =>
      each.rule ? [JSON.stringify(each.rule.expr)] : [],
    );
    expect(rules).toHaveLength(2);
    expect(rules[0]).toContain('"field":"dport"}},"right":"@reachports"');
    expect(rules[1]).toContain('"field":"sport"}},"right":"@reachports"');
    expect(rules[1]).toContain('"right":"reply"');
  });

  it("drops connections initiated by an allowed device from a port in a range", async () => {
    const address = await addressOf(device);
    const holderAddress = await addressOf(holderName(app));
    await holders.apply(app, {
      ...policy([address]),
      ports: [[50_000, 50_010]],
      manager: "test",
      holder,
    });
    await docker(
      "run",
      "--detach",
      "--name",
      listener,
      "--network",
      `container:${holder}`,
      "--cap-drop",
      "ALL",
      "alpine:latest",
      "sh",
      "-c",
      "nc -l -p 12345",
    );
    await expect
      .poll(() =>
        docker(
          "exec",
          listener,
          "sh",
          "-c",
          "cat /proc/net/tcp /proc/net/tcp6 | grep -c ':3039 ' || true",
        ),
      )
      .toBe("1");

    expect(
      await docker(
        "run",
        "--rm",
        "--network",
        `container:${device}`,
        "--cap-drop",
        "ALL",
        runtimeBase,
        "node",
        "-e",
        `const socket = require('node:net').connect({
          host: process.argv[1], port: 12345, localPort: 50006,
        });
        socket.setTimeout(2000, () => { console.log('timed out'); socket.destroy(); });
        socket.once('connect', () => { console.log('connected'); socket.destroy(); });`,
        holderAddress,
      ),
    ).toBe("timed out");
    await docker("rm", "--force", listener);
  });

  it("cuts a connection open on a port of a range it takes away", async () => {
    const address = await addressOf(device);
    await docker("rm", "--force", sayer, ticking).catch(() => "");
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
      "(while true; do echo tick; sleep 0.1; done) | nc -l -p 50005",
    );
    const sayerAddress = await addressOf(sayer);
    await holders.apply(app, {
      ...policy([address, sayerAddress]),
      ports: [6053, [50_000, 50_010]],
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
      "50005",
    );
    const ticks = async () =>
      (await docker("logs", ticking)).split("\n").filter(Boolean).length;
    await expect.poll(ticks, { timeout: 10_000 }).toBeGreaterThan(3);

    // The address stays; only the range goes.
    await holders.apply(app, {
      ...policy([address, sayerAddress]),
      ports: [6053],
      manager: "test",
      holder,
    });
    await new Promise((done) => setTimeout(done, 500));
    const cut = await ticks();
    await new Promise((done) => setTimeout(done, 1_500));

    expect(await ticks()).toBe(cut);
    await docker("rm", "--force", sayer, ticking).catch(() => "");
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
