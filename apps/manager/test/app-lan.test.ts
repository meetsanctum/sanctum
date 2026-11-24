import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  appContainerName,
  appContainerOptions,
  createAppContainers,
  nodeImage,
} from "../src/apps/containers.js";
import {
  createLanHolders,
  holderName,
  lanChange,
  lanNetworkName,
  lanPolicy,
  maxLanPorts,
  readRules,
  rulesFor,
} from "../src/apps/lan.js";
import { AppRefusal } from "../src/apps/refusal.js";
import { FakeDocker } from "./fake-docker.js";
import { listing, playNft } from "./fake-nft.js";

// An app that reaches the devices it found, in a network of its own: its
// holder's, whose rules a helper loads with nftables and reads back before the
// app's container starts, here with a stand-in for nft (fake-nft.ts).

const app = "sanctum.example";
const folder = "0.1.0+1a2b3c4d5e6f7a8b";
const managerImage = "sanctum-manager:test";
const policy = {
  core: "core-1",
  count: 1,
  addresses: ["192.168.1.40"],
  ports: [6053],
};

async function setup(options: { lan?: boolean } = {}) {
  const docker = new FakeDocker();
  docker.load(nodeImage, { title: "node", version: "24" });
  docker.load(managerImage, { title: "sanctum-manager", version: "test" });
  const nft = playNft(docker);
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-lan-"));
  const packageDir = join(dataDir, "packages", app, folder);
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), "{}");
  const holders = (run = "manager-1") =>
    createLanHolders({
      docker,
      image: async () => managerImage,
      run,
      reachable: (address) => address !== "192.168.1.99",
      log: vi.fn(),
    });
  const lan = holders();
  const apps = createAppContainers({
    docker,
    dataDir,
    log: vi.fn(),
    totalMemory: () => 8 * 1024 ** 3,
    ownFolder: async () => undefined,
    images: { ensure: async () => "sanctum-app-data-sanctum.example" },
    ...(options.lan === false ? {} : { lan }),
  });
  const inspect = (name: string) => docker.getContainer(name).inspect();
  return { apps, docker, nft, holders, inspect };
}

const start = { app, folder, memoryMb: 128 };

describe("an app's network rules", () => {
  it("drop whatever isn't one of its devices on its ports, replaced in one step", () => {
    expect(rulesFor(policy)).toBe(
      [
        "table inet sanctum",
        "delete table inet sanctum",
        "table inet sanctum {",
        '  comment "sanctum core-1 1"',
        "  set reach { type ipv4_addr; elements = { 192.168.1.40 }; }",
        "  set reachports { type inet_service; flags interval; elements = { 6053 }; }",
        "  chain output {",
        "    type filter hook output priority 0; policy drop;",
        "    ip daddr @reach tcp dport @reachports accept",
        "  }",
        "  chain input {",
        "    type filter hook input priority 0; policy drop;",
        "    ip saddr @reach tcp sport @reachports ct state established ct direction reply accept",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    // With nothing to reach, its sets are empty.
    expect(rulesFor({ ...policy, addresses: [], ports: [] })).toContain(
      "  set reach { type ipv4_addr; }",
    );
  });

  it("are read back from what nft lists", () => {
    expect(readRules(listing(rulesFor(policy)))).toEqual({
      marker: "sanctum core-1 1",
      addresses: ["192.168.1.40"],
      ports: [[6053, 6053]],
      drops: true,
    });
    expect(readRules("Error: No such file or directory")).toBeNull();
  });

  it("hold ranges of ports as intervals, joined where they overlap or touch", () => {
    expect(
      rulesFor({
        ...policy,
        ports: [[50_005, 60_000], 7001, [50_000, 50_010], 7000, 6053],
      }),
    ).toContain(
      "  set reachports { type inet_service; flags interval; elements = { 6053, 7000-7001, 50000-60000 }; }",
    );
  });

  it("read back ranges as nft lists them, and nothing they can't tell", () => {
    // As nft 1.1.6 lists a table holding 7000 and 49152-65535.
    const listed = (elem: unknown[]) =>
      JSON.stringify({
        nftables: [
          { metainfo: { version: "1.1.6", json_schema_version: 1 } },
          {
            table: {
              family: "inet",
              name: "sanctum",
              handle: 1,
              comment: "sanctum core-1 1",
            },
          },
          {
            set: {
              family: "inet",
              name: "reachports",
              table: "sanctum",
              type: "inet_service",
              handle: 4,
              flags: ["interval"],
              elem,
            },
          },
          { chain: { name: "output", hook: "output", policy: "drop" } },
          { chain: { name: "input", hook: "input", policy: "drop" } },
        ],
      });
    expect(
      readRules(listed([7000, 7001, { range: [49_152, 65_535] }]))?.ports,
    ).toEqual([
      [7000, 7001],
      [49_152, 65_535],
    ]);
    for (const elem of [
      ["ssh"],
      [{ prefix: { addr: 49_152, len: 2 } }],
      [{ range: [49_152] }],
      [{ range: [49_152, 65_535], extra: true }],
      [{ range: [49_152, 65_535] }, { range: [55_000, 50_000] }],
      [0],
      [65_536],
    ]) {
      expect(readRules(listed(elem))?.ports, JSON.stringify(elem)).toBeNull();
    }
  });
});

describe("an app's network policy as the core sends it", () => {
  const parsed = (ports: unknown[]) =>
    lanPolicy.safeParse({ ...policy, ports }).success;

  it("names ports, and ranges of them as [from, to]", () => {
    expect(parsed([6053, [49_152, 65_535]])).toBe(true);
    expect(
      lanChange.safeParse({
        ...policy,
        ports: [[49_152, 65_535]],
        manager: "manager-1",
        holder: "holder-1",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["a range that runs down", [[65_535, 49_152]]],
    ["a range of one port", [[50_000, 50_000]]],
    ["a range below the session ports", [[1, 65_535]]],
    ["a range with a third end", [[49_152, 60_000, 65_535]]],
    ["a range written as text", ["49152-65535"]],
    ["a port as text", ["6053"]],
    ["a port past the last", [[49_152, 65_536]]],
    ["no port", [0]],
    ["a fraction", [6053.5]],
    [
      "more than 16 entries",
      Array.from({ length: maxLanPorts + 1 }, (_, index) => 7000 + index),
    ],
  ])("refuses %s", (_, ports) => {
    expect(parsed(ports)).toBe(false);
  });
});

describe("an app that reaches devices", () => {
  it.each(["holder", "holder-next", "rules"])(
    "does not collide with an app whose id ends in -%s",
    async (suffix) => {
      const { apps, docker, inspect } = await setup();
      const otherApp = `${app}-${suffix}`;
      const other = docker.run(
        appContainerOptions({ ...start, app: otherApp }, "other-data"),
      );

      expect(await apps.start(start, { lan: policy })).toMatchObject({
        state: "running",
      });
      expect((await inspect(other.id)).State.Running).toBe(true);

      await apps.remove(app);
      expect((await inspect(other.id)).State.Running).toBe(true);
    },
  );

  it("starts in its holder's network, once the holder's rules are loaded", async () => {
    const { apps, docker, nft, inspect } = await setup();

    const started = await apps.start(start, { lan: policy });

    const holder = await inspect(holderName(app));
    expect(started.lan).toEqual({
      core: "core-1",
      count: 1,
      manager: "manager-1",
      holder: holder.Id,
    });
    expect((await inspect(appContainerName(app))).HostConfig.NetworkMode).toBe(
      `container:${holder.Id}`,
    );
    expect(holder.HostConfig).toMatchObject({
      NetworkMode: lanNetworkName(app),
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      RestartPolicy: { Name: "no" },
    });
    expect(holder.Config.User).toBe("65534:65534");
    expect(nft.loads).toEqual([{ holder: holder.Id, rules: rulesFor(policy) }]);
    // Its rules are in before the app's container starts.
    const events = docker.events.filter((each) => !each.startsWith("pull"));
    expect(events.indexOf(`start ${appContainerName(app)}`)).toBeGreaterThan(
      events.indexOf(`remove sanctum-lan-${app}-rules`),
    );
  });

  it("can't reach an address that isn't on the home's network", async () => {
    const { apps, nft } = await setup();

    await apps.start(start, {
      lan: { ...policy, addresses: ["192.168.1.40", "192.168.1.99"] },
    });

    expect(nft.loads.at(-1)!.rules).toContain("elements = { 192.168.1.40 };");
  });

  it("takes a newer policy for its holder, and refuses another holder's or an older one", async () => {
    const { apps, nft } = await setup();
    const { lan } = await apps.start(start, { lan: policy });
    const change = { ...policy, manager: "manager-1", holder: lan!.holder };

    await expect(
      apps.applyLan(app, { ...change, count: 2, holder: "another" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(apps.applyLan(app, change)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      await apps.applyLan(app, { ...change, count: 2, addresses: [] }),
    ).toEqual({ ...lan, count: 2 });
    expect(nft.tables.get(lan!.holder)).toContain(
      "set reach { type ipv4_addr; }",
    );
  });

  it("refuses rules nft lists with other ports than it was sent", async () => {
    const { apps, docker } = await setup();
    const { lan } = await apps.start(start, { lan: policy });
    const change = {
      ...policy,
      count: 2,
      manager: "manager-1",
      holder: lan!.holder,
    };
    const loading = docker.onRun!;
    docker.onRun = (options) => {
      const answer = loading(options);
      // A table that lets more through than it was sent.
      return answer?.code === 0
        ? {
            code: 0,
            output: listing(
              rulesFor({ ...change, ports: [6053, [49_152, 65_535]] }),
            ),
          }
        : answer;
    };

    await expect(apps.applyLan(app, change)).rejects.toThrow(
      "didn't take its rules",
    );
  });

  it("loads a range of ports, and takes it away again", async () => {
    const { apps, nft } = await setup();
    const { lan } = await apps.start(start, {
      lan: { ...policy, ports: [7000, [49_152, 65_535]] },
    });
    expect(nft.tables.get(lan!.holder)).toContain(
      "elements = { 7000, 49152-65535 };",
    );
    const change = { ...policy, manager: "manager-1", holder: lan!.holder };

    expect(
      await apps.applyLan(app, { ...change, count: 2, ports: [7000] }),
    ).toEqual({ ...lan, count: 2 });
    expect(nft.tables.get(lan!.holder)).toContain(
      "set reachports { type inet_service; flags interval; elements = { 7000 }; }",
    );
  });

  it("reads what its rules hold after the manager restarts", async () => {
    const { docker, apps, holders } = await setup();
    const { lan } = await apps.start(start, { lan: policy });
    const restarted = holders("manager-2");
    const change = { ...policy, manager: "manager-1", holder: lan!.holder };

    await expect(restarted.apply(app, change)).rejects.toMatchObject({
      status: 409,
    });
    expect(await restarted.apply(app, { ...change, count: 2 })).toEqual({
      ...lan,
      count: 2,
      manager: "manager-2",
    });
    expect(docker.events).not.toContain(`remove ${holderName(app)}`);
  });

  it("serializes overlapping changes and refuses one overtaken by a newer policy", async () => {
    const { apps, nft } = await setup();
    const { lan } = await apps.start(start, { lan: policy });
    const change = { ...policy, manager: "manager-1", holder: lan!.holder };

    const results = await Promise.allSettled([
      apps.applyLan(app, { ...change, count: 3, addresses: [] }),
      apps.applyLan(app, { ...change, count: 2 }),
    ]);

    expect(results[0]).toMatchObject({
      status: "fulfilled",
      value: { count: 3 },
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { status: 409 },
    });
    expect(readRules(listing(nft.tables.get(lan!.holder)!))).toMatchObject({
      marker: "sanctum core-1 3",
      addresses: [],
    });
  });

  it("refuses a delayed change from a core that its kept holder has replaced", async () => {
    const { apps, nft } = await setup();
    const { lan } = await apps.start(start, { lan: policy });
    await apps.start(start, {
      keep: true,
      lan: { ...policy, core: "core-2", addresses: [] },
    });

    await expect(
      apps.applyLan(app, {
        ...policy,
        count: 2,
        manager: "manager-1",
        holder: lan!.holder,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(readRules(listing(nft.tables.get(lan!.holder)!))).toMatchObject({
      marker: "sanctum core-2 1",
      addresses: [],
    });
  });

  it("rereads the holder after a load whose confirmation was lost", async () => {
    const { apps, docker, nft } = await setup();
    const { lan } = await apps.start(start, { lan: policy });
    const change = {
      ...policy,
      count: 3,
      addresses: [],
      manager: "manager-1",
      holder: lan!.holder,
    };
    const run = docker.onRun!;
    docker.onRun = (options) => {
      const result = run(options);
      return result
        ? { code: 1, output: "The rules could not be read back" }
        : null;
    };
    await expect(apps.applyLan(app, change)).rejects.toMatchObject({
      status: 500,
    });
    docker.onRun = run;

    await expect(
      apps.applyLan(app, { ...change, count: 2, addresses: policy.addresses }),
    ).rejects.toMatchObject({ status: 409 });
    expect(readRules(listing(nft.tables.get(lan!.holder)!))).toMatchObject({
      marker: "sanctum core-1 3",
      addresses: [],
    });
  });

  it("leaves the policy unchanged when a restarted manager cannot read its version", async () => {
    const { apps, docker, nft, holders } = await setup();
    const { lan } = await apps.start(start, {
      lan: { ...policy, count: 3, addresses: [] },
    });
    const restarted = holders("manager-2");
    const run = docker.onRun!;
    docker.onRun = (options) =>
      options.Cmd?.[2]?.includes("nft -f -")
        ? run(options)
        : { code: 1, output: "The rules could not be read" };

    await expect(
      restarted.apply(app, {
        ...policy,
        count: 2,
        manager: "manager-1",
        holder: lan!.holder,
      }),
    ).rejects.toMatchObject({ status: 500 });

    expect(nft.loads).toHaveLength(1);
    expect(readRules(listing(nft.tables.get(lan!.holder)!))).toMatchObject({
      marker: "sanctum core-1 3",
      addresses: [],
    });
  });

  it("goes on through a core's restart in the holder it shares", async () => {
    const { apps, nft } = await setup();
    const { lan } = await apps.start(start, { lan: policy });

    const kept = await apps.start(start, {
      keep: true,
      lan: { ...policy, core: "core-2" },
    });

    expect(kept).toMatchObject({
      kept: true,
      lan: { core: "core-2", count: 1, holder: lan!.holder },
    });
    expect(nft.loads.map((each) => each.holder)).toEqual([
      lan!.holder,
      lan!.holder,
    ]);
  });

  it("is made again, holder and all, when its holder has stopped", async () => {
    const { apps, docker, inspect } = await setup();
    const { lan } = await apps.start(start, { lan: policy });
    await docker.getContainer(lan!.holder).stop();

    const started = await apps.start(start, {
      keep: true,
      lan: { ...policy, core: "core-2" },
    });

    expect(started.kept).toBeUndefined();
    expect(started.lan!.holder).not.toBe(lan!.holder);
    expect((await inspect(appContainerName(app))).HostConfig.NetworkMode).toBe(
      `container:${started.lan!.holder}`,
    );
  });

  it("stops when its holder has, and takes its holder with it when it stops or goes", async () => {
    const { apps, docker, inspect } = await setup();
    const { lan } = await apps.start(start, { lan: policy });

    await docker.getContainer(lan!.holder).stop();
    await apps.stopStranded();
    expect((await inspect(appContainerName(app))).State.Running).toBe(false);

    await apps.start(start, { lan: policy });
    await apps.stop(app);
    expect((await inspect(holderName(app))).State.Running).toBe(false);

    await apps.remove(app);
    await expect(inspect(holderName(app))).rejects.toThrow();
    expect(docker.events).toContain(`remove network ${lanNetworkName(app)}`);
  });

  it("is refused by a manager that can't give it a network of its own", async () => {
    const { apps } = await setup({ lan: false });

    await expect(apps.start(start, { lan: policy })).rejects.toBeInstanceOf(
      AppRefusal,
    );
    expect(apps.reachesDevices()).toBe(false);
  });
});
