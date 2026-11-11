import { link, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { StatusDockerLike } from "../src/docker.js";
import { createHostReadings } from "../src/host/readings.js";
import type { ImageStatus } from "../src/apps/images.js";
import { createHostStatus } from "../src/host/status.js";
import { createServer } from "../src/server.js";
import type { ServiceStatus } from "../src/services/services.js";

// Settings → Status: what the host's kernel and Docker say about it, as the
// manager reports it on GET /api/host/status. The files are a Raspberry Pi
// 4's, read inside the manager's container on the dev Pi (2026-11-02).

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const stat = (busy: number, idle: number) =>
  `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\n`;

// A Pi's /proc and /sys, under a folder of their own.
async function pi(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "sanctum-host-"));
  const all: Record<string, string> = {
    "proc/cpuinfo":
      "processor\t: 0\nBogoMIPS\t: 108.00\n\nRevision\t: d03114\nSerial\t\t: 10000000c8a1f2b3\nModel\t\t: Raspberry Pi 4 Model B Rev 1.4\n",
    "proc/meminfo":
      "MemTotal:        8007400 kB\nMemFree:         6012000 kB\nMemAvailable:    7365644 kB\nSwapTotal:       2097148 kB\nSwapFree:        2097148 kB\n",
    "proc/uptime": "421763.72 1659782.30\n",
    "proc/stat": stat(100, 900),
    "proc/net/route":
      "Iface\tDestination\tGateway \tFlags\nwlan0\t0007A8C0\t00000000\t0001\nwlan0\t00000000\t0107A8C0\t0003\n",
    "proc/net/wireless":
      "Inter-| sta-|   Quality        |   Discarded packets\n face | tus | link level noise |  nwid  crypt\n wlan0: 0000   70.  -37.  -256        0      0\n",
    "sys/class/thermal/thermal_zone0/temp": "57452\n",
    "sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq": "1800000\n",
    "sys/class/hwmon/hwmon0/name": "cpu_thermal\n",
    "sys/class/hwmon/hwmon1/name": "rpi_volt\n",
    "sys/class/hwmon/hwmon1/in0_lcrit_alarm": "0\n",
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return {
    root,
    set: (path: string, text: string) => writeFile(join(root, path), text),
  };
}

const interfaces = () => ({
  wlan0: [
    {
      address: "192.168.7.222",
      netmask: "255.255.255.0",
      family: "IPv4" as const,
      mac: "dc:a6:32:01:02:03",
      internal: false,
      cidr: "192.168.7.222/24",
    },
  ],
});

// Docker on the dev Pi: its containers, what ps says of each, and df.
function docker(
  options: { charged?: Record<string, number> } = {},
): StatusDockerLike & { dfCalls: number } {
  const managed = (role: string) => ({
    "sanctum.managed": "true",
    "sanctum.role": role,
  });
  const compose = (service: string) => ({
    "com.docker.compose.project": "sanctum",
    "com.docker.compose.service": service,
  });
  const containers = [
    { Id: "core", Labels: managed("core"), rss: ["167452"] },
    { Id: "manager", Labels: compose("manager"), rss: ["106948"] },
    { Id: "z2m", Labels: managed("zigbee2mqtt"), rss: ["576", "134452"] },
    { Id: "broker", Labels: managed("mosquitto"), rss: ["8012"] },
    { Id: "registry", Labels: compose("registry"), rss: ["44788"] },
    {
      Id: "weather",
      Labels: { ...managed("app"), "sanctum.app": "sanctum.weather" },
      rss: ["30000"],
    },
    { Id: "someone-elses", Labels: {}, rss: ["99999"] },
  ];
  const charged: Record<string, number> = options.charged ?? {};
  const fake = {
    dfCalls: 0,
    info: async () => ({
      Name: "sanctum-dev.local",
      OperatingSystem: "Debian GNU/Linux 13 (trixie)",
      Architecture: "aarch64",
    }),
    df: async () => {
      fake.dfCalls += 1;
      return {
        LayersSize: 1_207_000_000,
        Volumes: [
          { Name: "sanctum-core-data", UsageData: { Size: 11_660_000 } },
          { Name: "sanctum-registry-data", UsageData: { Size: 1_349_000_000 } },
          { Name: "sanctum-zigbee2mqtt-data", UsageData: { Size: 9_183 } },
          { Name: "sanctum-mosquitto-data", UsageData: { Size: 280_500 } },
        ],
      };
    },
    listContainers: async () =>
      containers.map(({ Id, Labels }) => ({ Id, Labels })),
    getContainer: (id: string) => ({
      top: async () => ({
        Titles: ["PID", "RSS"],
        Processes: containers
          .find((each) => each.Id === id)!
          .rss.map((rss, index) => [String(index + 1), rss]),
      }),
      stats: async () =>
        charged[id] ? { memory_stats: { usage: charged[id] } } : {},
    }),
  };
  return fake;
}

const zigbeeServices: ServiceStatus[] = [
  { name: "mosquitto", apps: [], state: "running", restarts: 0 },
  {
    name: "zigbee2mqtt",
    apps: ["sanctum.zigbee"],
    state: "running",
    restarts: 0,
  },
];

async function reporter(
  options: {
    files?: Record<string, string>;
    docker?: StatusDockerLike;
    services?: ServiceStatus[];
    images?: { listOrNone: () => Promise<ImageStatus[]> };
    now?: () => Date;
  } = {},
) {
  const host = await pi(options.files);
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-manager-"));
  await mkdir(
    join(dataDir, "backups", "core-20261102T181100.633-dev-717fbe1"),
    {
      recursive: true,
    },
  );
  await writeFile(
    join(dataDir, "backups", "core-20261102T181100.633-dev-717fbe1", "core.db"),
    Buffer.alloc(4096),
  );
  const logs: string[] = [];
  const status = createHostStatus({
    readings: createHostReadings({ root: host.root, interfaces }),
    docker: options.docker,
    services: { list: () => options.services ?? [] },
    images: options.images,
    dataDir,
    channel: "dev",
    clock: async () => true,
    log: (message) => logs.push(message),
    now: options.now,
  });
  return { host, status, logs, dataDir };
}

describe("the host's status", () => {
  it("says what a Pi is, and how it is doing", async () => {
    const { status } = await reporter({
      docker: docker(),
      services: zigbeeServices,
    });
    await status.sample();

    const report = await status.status();

    expect(report).toMatchObject({
      channel: "dev",
      model: "Raspberry Pi 4 Model B",
      os: "Debian GNU/Linux 13 (trixie)",
      architecture: "aarch64",
      hostname: "sanctum-dev",
      uptimeSeconds: 421763,
      memory: {
        total: 8007400 * 1024,
        available: 7365644 * 1024,
        swapTotal: 2097148 * 1024,
        swapFree: 2097148 * 1024,
      },
      processor: { mhz: 1800, celsius: 57.5 },
      power: { low: false, lastLowAt: null },
      network: {
        interface: "wlan0",
        kind: "wifi",
        address: "192.168.7.222",
        signalDbm: -37,
        speedMbps: null,
      },
      clock: true,
      services: zigbeeServices,
    });
    expect(report.processor.cores).toBeGreaterThan(0);
  });

  it("leaves the hostname unknown when Docker cannot report the host's name", async () => {
    const { status } = await reporter({
      docker: {
        ...docker(),
        info: async () => {
          throw new Error("away");
        },
      },
    });

    expect((await status.status()).hostname).toBeNull();
  });

  it("counts each of Sanctum's containers' memory, and leaves others to the system", async () => {
    const { status } = await reporter({ docker: docker() });

    const { memory } = await status.status();

    expect(memory?.containers).toEqual([
      { role: "core", bytes: 167452 * 1024 },
      { role: "manager", bytes: 106948 * 1024 },
      {
        role: "service",
        service: "zigbee2mqtt",
        apps: [],
        bytes: (576 + 134452) * 1024,
      },
      { role: "service", service: "mosquitto", apps: [], bytes: 8012 * 1024 },
      { role: "registry", bytes: 44788 * 1024 },
      { role: "app", app: "sanctum.weather", bytes: 30000 * 1024 },
    ]);
  });

  it("counts what the kernel charges a container, where it keeps a count", async () => {
    const { status } = await reporter({
      docker: docker({ charged: { weather: 12_000_000, core: 90_000_000 } }),
    });

    const { memory } = await status.status();

    expect(memory!.containers).toContainEqual({
      role: "app",
      app: "sanctum.weather",
      bytes: 12_000_000,
    });
    expect(memory!.containers).toContainEqual({
      role: "core",
      bytes: 90_000_000,
    });
    expect(memory!.containers).toContainEqual({
      role: "manager",
      bytes: 106948 * 1024,
    });
  });

  it("says which apps a service is for, and those of the services that need it", async () => {
    const { status } = await reporter({
      docker: docker(),
      services: zigbeeServices,
    });

    const { memory } = await status.status();

    expect(memory!.containers).toContainEqual({
      role: "service",
      service: "zigbee2mqtt",
      apps: ["sanctum.zigbee"],
      bytes: (576 + 134452) * 1024,
    });
    expect(memory!.containers).toContainEqual({
      role: "service",
      service: "mosquitto",
      apps: ["sanctum.zigbee"],
      bytes: 8012 * 1024,
    });
  });

  it("leaves out a container that stops while it's read", async () => {
    const stopping = docker();
    const { getContainer } = stopping;
    stopping.getContainer = (id) => ({
      ...getContainer(id),
      ...(id === "weather"
        ? {
            top: () => Promise.reject(new Error("Not running")),
            stats: () => Promise.reject(new Error("Not running")),
          }
        : {}),
    });
    const { status } = await reporter({ docker: stopping });

    const { memory } = await status.status();

    expect(memory!.containers.map(({ role }) => role)).not.toContain("app");
    expect(memory!.containers.map(({ role }) => role)).toContain("core");
  });

  it("says what takes the space: software, dev builds, backups and each service's data, for its apps", async () => {
    const { status } = await reporter({
      docker: docker(),
      services: zigbeeServices,
    });

    const { storage } = await status.status();

    expect(storage).toMatchObject({
      software: 1_207_000_000,
      devBuilds: 1_349_000_000,
      backups: 4096,
      // The broker is Zigbee's too: its bridge needs it.
      services: [
        { service: "mosquitto", apps: ["sanctum.zigbee"], bytes: 280_500 },
        { service: "zigbee2mqtt", apps: ["sanctum.zigbee"], bytes: 9_183 },
      ],
    });
    expect(storage!.total).toBeGreaterThan(storage!.free);
  });

  it("says whether Docker can hold a container to its memory", async () => {
    const withInfo = (info: object) => ({
      ...docker(),
      info: async () => ({ Name: "pi", ...info }),
    });
    const read = async (info: object) => {
      const { status } = await reporter({ docker: withInfo(info) });
      return (await status.status()).memoryLimits;
    };

    expect(await read({ MemoryLimit: true, SwapLimit: true })).toBe(true);
    expect(await read({ MemoryLimit: false, SwapLimit: false })).toBe(false);
    expect(await read({ MemoryLimit: true, SwapLimit: false })).toBe(false);
    expect(await read({})).toBeNull();
  });

  it("reports each app's image", async () => {
    const image = {
      app: "sanctum.weather",
      state: "ok" as const,
      sizeMb: 256,
      bytes: 9,
    };
    const { status } = await reporter({
      docker: docker(),
      images: { listOrNone: async () => [image] },
    });

    expect((await status.status()).storage?.images).toEqual([image]);
  });

  it("reports an app's own container by the app", async () => {
    const { status } = await reporter({ docker: docker() });

    const { memory } = await status.status();

    expect(memory!.containers).toContainEqual({
      role: "app",
      app: "sanctum.weather",
      bytes: 30_000 * 1024,
    });
  });

  it("counts the apps' packages as software, and a file they share once", async () => {
    const { dataDir, status } = await reporter({ docker: docker() });
    const weather = join(dataDir, "packages/sanctum.weather/0.3.0+a");
    const moods = join(dataDir, "packages/sanctum.moods/0.2.0+b");
    await mkdir(weather, { recursive: true });
    await mkdir(moods, { recursive: true });
    await writeFile(join(weather, "shared.js"), "x".repeat(1000));
    await link(join(weather, "shared.js"), join(moods, "shared.js"));
    await writeFile(join(moods, "own.js"), "y".repeat(24));

    const { storage } = await status.status();

    expect(storage).toMatchObject({ software: 1_207_000_000 + 1024 });
  });

  it("counts the space again only after 10 minutes", async () => {
    let now = new Date("2026-11-02T18:00:00Z").getTime();
    const counting = docker();
    const { status } = await reporter({
      docker: counting,
      now: () => new Date(now),
    });

    await status.status();
    now += 9 * 60_000;
    await status.status();
    expect(counting.dfCalls).toBe(1);

    now += 2 * 60_000;
    await status.status();
    await status.status();
    expect(counting.dfCalls).toBe(2);
  });

  it("leaves unmeasured volume sizes unknown instead of counting negative or zero bytes", async () => {
    const { status } = await reporter({
      docker: {
        ...docker(),
        df: async () => ({
          Volumes: [
            { Name: "sanctum-registry-data", UsageData: { Size: -1 } },
            { Name: "sanctum-zigbee2mqtt-data", UsageData: null },
            { Name: "sanctum-mosquitto-data", UsageData: { Size: 0 } },
          ],
        }),
      },
      services: zigbeeServices,
    });

    expect((await status.status()).storage).toMatchObject({
      devBuilds: null,
      services: [{ service: "mosquitto", apps: ["sanctum.zigbee"], bytes: 0 }],
    });
  });

  it("answers without the sizes when Docker can't count them", async () => {
    const failing = {
      ...docker(),
      df: () => Promise.reject(new Error("busy")),
    };
    const { status, logs } = await reporter({ docker: failing });

    const { storage } = await status.status();

    expect(storage).toMatchObject({
      software: null,
      devBuilds: null,
      backups: null,
      services: [],
    });
    expect(logs).toEqual(["Could not count what takes the space: busy"]);
  });

  it("measures how busy the processor was since the last sample", async () => {
    const { host, status } = await reporter();
    await status.sample();
    // 300 busy ticks of 1,000 since.
    await host.set("proc/stat", stat(400, 1600));
    await status.sample();

    expect((await status.status()).processor.usage).toBeCloseTo(0.3);
  });

  it("remembers when the power last went low, after it recovers", async () => {
    let now = new Date("2026-11-02T18:40:00Z");
    const { host, status } = await reporter({ now: () => now });
    await host.set("sys/class/hwmon/hwmon1/in0_lcrit_alarm", "1\n");
    await status.sample();
    expect((await status.status()).power).toEqual({
      low: true,
      lastLowAt: "2026-11-02T18:40:00.000Z",
    });

    now = new Date("2026-11-02T18:40:10Z");
    await host.set("sys/class/hwmon/hwmon1/in0_lcrit_alarm", "0\n");
    await status.sample();
    expect((await status.status()).power).toEqual({
      low: false,
      lastLowAt: "2026-11-02T18:40:00.000Z",
    });
  });

  it("says Ethernet's speed, and nothing a machine that isn't a Pi can't say", async () => {
    const { status } = await reporter({
      files: {
        "proc/cpuinfo": "processor\t: 0\nmodel name\t: Intel(R) N100\n",
        "proc/net/route":
          "Iface\tDestination\tGateway \tFlags\neth0\t00000000\t0101A8C0\t0003\n",
        "sys/class/net/eth0/speed": "1000\n",
        "sys/class/hwmon/hwmon1/name": "nvme\n",
      },
    });
    await status.sample();

    const report = await status.status();

    expect(report).toMatchObject({
      model: null,
      os: null,
      power: null,
      network: { kind: "ethernet", speedMbps: 1000, signalDbm: null },
    });
    expect(report.memory?.containers).toEqual([]);
  });
});

describe("GET /api/host/status", () => {
  it("answers with the host's status", async () => {
    const { status } = await reporter();
    const server = createServer({ version: "dev-1" }, { status });
    servers.push(server);

    const response = await server.inject("/api/host/status");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ model: "Raspberry Pi 4 Model B" });
  });

  it("refuses where the manager reports no host", async () => {
    const server = createServer({ version: "dev-1" });
    servers.push(server);

    const response = await server.inject("/api/host/status");

    expect(response.statusCode).toBe(503);
  });
});
