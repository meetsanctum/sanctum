import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadAppPackages } from "./runner-apps.js";
import { ManagerUnavailable, type HostStatus } from "../src/manager.js";
import { createStatus, type SystemStatus } from "../src/system/status.js";
import { personWithClient } from "./devices-support.js";
import {
  claimed,
  fakeManager,
  fixtureApps,
  get,
  managerSocket,
  piStatus,
  sharedClient,
  testCore,
} from "./support.js";

// Settings → Status: the host as its manager reports it, the space the core's
// own data and each app's take, and what needs someone, for every client.

async function statusOf(
  host: () => Promise<HostStatus>,
  options: { apps?: boolean } = {},
) {
  const apps = options.apps
    ? (await loadAppPackages(fixtureApps, "official")).filter(
        ({ app }) => app.id === "test.notes",
      )
    : [];
  const core = await testCore({
    manager: { ...fakeManager().manager, hostStatus: host },
    apps,
  });
  const admin = await claimed(core);
  const read = async () =>
    (await get(core, "/api/system/status", admin)).json() as SystemStatus;
  return { core, admin, read };
}

describe("the host's status", () => {
  it("tells every client what the host is and how it is doing", async () => {
    const { core } = await statusOf(async () => piStatus());

    for (const { token } of [sharedClient(core), personWithClient(core)]) {
      const response = await get(core, "/api/system/status", { token });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        checkedAt: "2026-10-26T12:00:00.000Z",
        version: "1.2.3",
        channel: "dev",
        host: {
          model: "Raspberry Pi 4 Model B",
          os: "Debian GNU/Linux 13 (trixie)",
          bits: 64,
          uptimeSeconds: 421_763,
          hostname: "sanctum-dev",
          processor: { cores: 4, usage: 0.03, mhz: 1800, celsius: 57.5 },
          power: { low: false, lastLowAt: null },
          network: { kind: "wifi", signalDbm: -37 },
          clock: true,
        },
        problems: [],
      });
    }
  });

  it("says what holds the memory: Sanctum, its services, the dev builds and the system", async () => {
    const { read } = await statusOf(async () => piStatus());

    const { memory } = (await read()).host!;

    const host = piStatus().memory!;
    const counted = host.containers.reduce((sum, each) => sum + each.bytes, 0);
    expect(memory).toEqual({
      total: host.total,
      available: host.available,
      swapTotal: host.swapTotal,
      swapUsed: 0,
      parts: [
        { kind: "core", bytes: 171_470_848 },
        { kind: "manager", bytes: 109_514_752 },
        { kind: "service", service: "zigbee2mqtt", bytes: 138_272_768 },
        { kind: "service", service: "mosquitto", bytes: 8_204_288 },
        { kind: "devBuilds", bytes: 45_862_912 },
        { kind: "system", bytes: host.total - host.available - counted },
      ],
    });
  });

  const partsOf = async (host: HostStatus, appIds: readonly string[]) => {
    const status = createStatus({
      manager: { ...fakeManager().manager, hostStatus: async () => host },
      dataDir: await mkdtemp(join(tmpdir(), "sanctum-status-")),
      version: "1.0.0",
      appIds: () => appIds,
    });
    return (await status.status()).host!.memory!.parts;
  };

  const withContainers = (
    ...containers: NonNullable<
      ReturnType<typeof piStatus>["memory"]
    >["containers"]
  ) => {
    const host = piStatus();
    return {
      ...host,
      memory: {
        ...host.memory!,
        containers: [
          ...host.memory!.containers.filter(({ role }) => role !== "service"),
          ...containers,
        ],
      },
    };
  };

  it("gives an app in its own container its own part, leaving Sanctum's alone", async () => {
    const parts = await partsOf(
      withContainers({
        role: "app",
        app: "test.weather",
        bytes: 30_000_000,
      }),
      ["test.weather"],
    );

    expect(parts).toContainEqual({ kind: "core", bytes: 171_470_848 });
    expect(parts).toContainEqual({
      kind: "app",
      app: "test.weather",
      bytes: 30_000_000,
      services: [],
    });
  });

  it("folds a service into the app it's for, whether or not that has a container", async () => {
    const parts = await partsOf(
      withContainers(
        {
          role: "service",
          service: "zigbee2mqtt",
          apps: ["test.zigbee"],
          bytes: 100,
        },
        {
          role: "service",
          service: "mosquitto",
          apps: ["test.zigbee"],
          bytes: 10,
        },
      ),
      ["test.zigbee"],
    );

    expect(parts).toContainEqual({
      kind: "app",
      app: "test.zigbee",
      bytes: 110,
      services: ["mosquitto", "zigbee2mqtt"],
    });
    expect(parts.map(({ kind }) => kind)).not.toContain("service");
  });

  it("shares a service between the apps it's for", async () => {
    const parts = await partsOf(
      withContainers(
        { role: "app", app: "test.one", bytes: 1_000 },
        {
          role: "service",
          service: "mosquitto",
          apps: ["test.one", "test.two", "test.gone"],
          bytes: 100,
        },
      ),
      ["test.one", "test.two"],
    );

    expect(parts).toContainEqual({
      kind: "app",
      app: "test.one",
      bytes: 1_050,
      services: ["mosquitto"],
    });
    expect(parts).toContainEqual({
      kind: "app",
      app: "test.two",
      bytes: 50,
      services: ["mosquitto"],
    });
  });

  it("keeps a service on its own while no installed app uses it, or an older manager doesn't say", async () => {
    const parts = await partsOf(
      withContainers(
        {
          role: "service",
          service: "zigbee2mqtt",
          apps: ["test.gone"],
          bytes: 100,
        },
        { role: "service", service: "mosquitto", bytes: 10 },
      ),
      ["test.weather"],
    );

    expect(parts).toContainEqual({
      kind: "service",
      service: "zigbee2mqtt",
      bytes: 100,
    });
    expect(parts).toContainEqual({
      kind: "service",
      service: "mosquitto",
      bytes: 10,
    });
  });

  it("leaves the container of an app no longer installed to the system's part", async () => {
    const host = withContainers({
      role: "app",
      app: "test.gone",
      bytes: 30_000_000,
    });
    const parts = await partsOf(host, []);

    expect(parts.map(({ kind }) => kind)).not.toContain("app");
    const counted = host.memory.containers
      .filter(({ role }) => role !== "app")
      .reduce((sum, each) => sum + each.bytes, 0);
    expect(parts).toContainEqual({
      kind: "system",
      bytes: host.memory.total - host.memory.available - counted,
    });
  });

  it("says memory limits are off only while an app runs without them", async () => {
    const host = piStatus();
    const withApp = (memoryLimits: boolean | null) => ({
      ...host,
      memoryLimits,
      memory: {
        ...host.memory!,
        containers: [
          ...host.memory!.containers,
          { role: "app" as const, app: "sanctum.weather", bytes: 30_000_000 },
        ],
      },
    });
    const problems = async (status: HostStatus) => {
      const { read } = await statusOf(async () => status);
      return (await read()).problems.map(({ kind }) => kind);
    };

    expect(await problems(withApp(false))).toContain("memoryLimits");
    expect(await problems(withApp(true))).not.toContain("memoryLimits");
    // An older manager doesn't say.
    expect(await problems(withApp(null))).not.toContain("memoryLimits");
    // With no app in a container, nothing is affected.
    expect(await problems({ ...host, memoryLimits: false })).not.toContain(
      "memoryLimits",
    );
  });

  it("says when an app's data is missing or damaged, and counts what it takes", async () => {
    const host = piStatus();
    const status: HostStatus = {
      ...host,
      storage: {
        ...host.storage!,
        images: [
          {
            app: "sanctum.weather",
            state: "ok",
            sizeMb: 256,
            bytes: 9_000_000,
          },
          { app: "sanctum.moods", state: "missing", sizeMb: 256, bytes: 0 },
          { app: "sanctum.zigbee", state: "damaged", sizeMb: 256, bytes: 1 },
        ],
      },
    };
    const { read } = await statusOf(async () => status);

    expect((await read()).problems).toEqual(
      expect.arrayContaining([
        { kind: "appData", app: "sanctum.moods", state: "missing" },
        { kind: "appData", app: "sanctum.zigbee", state: "damaged" },
      ]),
    );
  });

  it("says what takes the space, each app's data with its services'", async () => {
    const host = piStatus();
    host.storage!.services = [
      { service: "mosquitto", apps: ["test.notes"], bytes: 280_500 },
      { service: "zigbee2mqtt", apps: ["test.notes"], bytes: 9_183 },
    ];
    const { core, read } = await statusOf(async () => host, { apps: true });
    // A file the core keeps beside its database, and an app that's gone.
    await writeFile(join(core.dataDir, "core-before-0023.db"), "x".repeat(500));
    await mkdir(join(core.dataDir, "apps"), { recursive: true });
    await writeFile(join(core.dataDir, "apps", "test.gone.db"), "x".repeat(70));

    const { storage } = (await read()).host!;

    const notes = (
      await Promise.all(
        ["", "-wal", "-shm"].map((end) =>
          stat(join(core.dataDir, "apps", `test.notes.db${end}`)).then(
            (file) => file.size,
            () => 0,
          ),
        ),
      )
    ).reduce((sum, size) => sum + size, 0);
    expect(notes).toBeGreaterThan(0);
    const app = storage!.parts.find((part) => part.kind === "app");
    expect(app).toEqual({
      kind: "app",
      app: "test.notes",
      bytes: notes + 280_500 + 9_183,
    });
    const home = storage!.parts.find((part) => part.kind === "home");
    expect(home).toMatchObject({ backups: 17_400_000 });
    if (home?.kind !== "home") throw new Error("no home part");
    // The core's database, the file beside it and the gone app's.
    expect(home.data).toBeGreaterThan(570);
    expect(home.bytes).toBe(home.data + 17_400_000);
    expect(storage!.parts.map((part) => part.kind)).toEqual([
      "devBuilds",
      "software",
      "home",
      "app",
      "system",
    ]);
    const system = storage!.parts.at(-1)!;
    const counted = storage!.parts
      .slice(0, -1)
      .reduce((sum, part) => sum + part.bytes, 0);
    expect(system.bytes).toBe(
      host.storage!.total - host.storage!.free - counted,
    );
  });

  it("counts an app's image even when its database lives outside the core", async () => {
    const host = piStatus();
    host.storage!.images = [
      { app: "test.notes", state: "ok", sizeMb: 256, bytes: 9_000_000 },
    ];
    const { core, read } = await statusOf(async () => host, { apps: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(join(core.dataDir, "apps", `test.notes.db${suffix}`), {
        force: true,
      });
    }

    expect((await read()).host!.storage!.parts).toContainEqual({
      kind: "app",
      app: "test.notes",
      bytes: 9_000_000,
    });
  });

  it("works out what needs someone, the most pressing first", async () => {
    const host = piStatus();
    host.power = { low: false, lastLowAt: "2026-10-26T10:00:00.000Z" };
    host.storage!.free = 800_000_000;
    host.processor.celsius = 83;
    host.memory = {
      ...host.memory!,
      available: 90_000_000,
      swapFree: host.memory!.swapTotal - 410_000_000,
    };
    host.services[1] = {
      name: "zigbee2mqtt",
      apps: ["sanctum.zigbee"],
      state: "waiting",
      problem: "No Zigbee coordinator is plugged in",
    };
    host.clock = false;
    const { read } = await statusOf(async () => host);

    expect((await read()).problems).toEqual([
      { kind: "power", lastLowAt: "2026-10-26T10:00:00.000Z" },
      { kind: "storage", free: 800_000_000 },
      { kind: "heat", celsius: 83 },
      { kind: "memory", available: 90_000_000, total: host.memory.total },
      {
        kind: "service",
        service: "zigbee2mqtt",
        state: "waiting",
        problem: "No Zigbee coordinator is plugged in",
        apps: ["sanctum.zigbee"],
      },
      { kind: "clock" },
    ]);
  });

  it("forgets a weak supply after a day, and leaves swap alone while memory is free", async () => {
    const host = piStatus();
    host.power = { low: false, lastLowAt: "2026-10-25T11:00:00.000Z" };
    host.memory!.swapFree = host.memory!.swapTotal - 410_000_000;
    host.processor.celsius = 79.9;
    host.storage!.free = 1_600_000_000;
    const { read } = await statusOf(async () => host);

    expect((await read()).problems).toEqual([]);
  });

  it("answers what it knows while the manager doesn't", async () => {
    const { read } = await statusOf(async () => {
      throw new ManagerUnavailable("The manager did not answer");
    });

    expect(await read()).toEqual({
      checkedAt: "2026-10-26T12:00:00.000Z",
      version: "1.2.3",
      channel: null,
      host: null,
      problems: [],
    });
  });

  it("asks the manager on its socket, and keeps only what it reports", async () => {
    const socket = await managerSocket((request) =>
      request.url === "/api/host/status"
        ? {
            status: 200,
            body: {
              ...piStatus(),
              services: piStatus().services.map((service) => ({
                ...service,
                image: "eclipse-mosquitto:2",
                restarts: 0,
              })),
            },
          }
        : { status: 404, body: { error: "Not found" } },
    );

    expect(await socket.client.hostStatus()).toEqual(piStatus());
  });
});
