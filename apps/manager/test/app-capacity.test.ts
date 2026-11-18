import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCapacity } from "../src/apps/capacity.js";
import type { AppContainers } from "../src/apps/containers.js";
import type { AppImages } from "../src/apps/images.js";
import type { UpdateService } from "../src/update/service.js";
import { createServer } from "../src/server.js";

// What the manager has promised of the host's memory and disk: every app it
// holds that isn't off, the services it runs and what adds reserved.

const gibibyte = 1024 * 1024 * 1024;
const mebibyte = 1024 * 1024;
const folders: string[] = [];

afterEach(async () => {
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

async function ledger(
  options: { services?: string[]; dataDir?: string; now?: () => number } = {},
) {
  const dataDir =
    options.dataDir ?? (await mkdtemp(join(tmpdir(), "sanctum-capacity-")));
  if (!options.dataDir) folders.push(dataDir);
  // 2 GiB keeps 1 GiB for the host, which leaves 1024 MB for apps.
  const capacity = createCapacity({
    dataDir,
    totalMemory: () => 2 * gibibyte,
    services: () => options.services ?? [],
    serviceMemoryMb: (name) => ({ mosquitto: 32, zigbee2mqtt: 256 })[name] ?? 0,
    now: options.now,
  });
  return { capacity, dataDir };
}

const moods = { app: "sanctum.moods", memoryMb: 128 };
const add = { memoryMb: 128, dataMb: 256, services: [] };
const plenty = async () => 10 * gibibyte;

describe("what's left for apps", () => {
  it("counts every app held, the services that run and what's reserved", async () => {
    const { capacity } = await ledger({ services: ["mosquitto"] });
    await capacity.reserve("sanctum.weather", add, [moods], plenty);

    expect(await capacity.freeMb([moods])).toBe(1024 - 128 - 32 - 128);
    // An app's own count is left out of what's left for it.
    expect(await capacity.freeMb([moods], "sanctum.weather")).toBe(
      1024 - 128 - 32,
    );
  });

  it("gives back the room of an app turned off, kept across restarts", async () => {
    const { capacity, dataDir } = await ledger();
    await capacity.turnedOff("sanctum.moods");
    expect(await capacity.freeMb([moods])).toBe(1024);

    const again = await ledger({ dataDir });
    expect(await again.capacity.freeMb([moods])).toBe(1024);
    await again.capacity.started("sanctum.moods");
    expect(await again.capacity.freeMb([moods])).toBe(1024 - 128);
  });
});

describe("reserving what an add needs", () => {
  it("refuses what doesn't fit, its services counted, saying what's left", async () => {
    const { capacity } = await ledger({ services: ["mosquitto"] });
    const held = [{ app: "sanctum.moods", memoryMb: 700 }];

    await expect(
      capacity.reserve(
        "sanctum.zigbee",
        { ...add, services: ["zigbee2mqtt"] },
        held,
        plenty,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message:
        "sanctum.zigbee needs 384 MB, and only 292 MB are left beside the others",
    });
    await expect(
      capacity.reserve("sanctum.zigbee", add, held, plenty),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("refuses data the disk can't spare", async () => {
    const { capacity } = await ledger();

    await expect(
      capacity.reserve("sanctum.weather", add, [], async () => 100 * mebibyte),
    ).rejects.toThrow(
      "sanctum.weather needs 256 MB for its data, and only 100 MB can be spared",
    );
  });

  it("holds the room from another add until its app starts", async () => {
    const { capacity } = await ledger();
    await capacity.reserve(
      "sanctum.weather",
      { ...add, memoryMb: 900 },
      [],
      plenty,
    );

    await expect(
      capacity.reserve("sanctum.moods", add, [], plenty),
    ).rejects.toMatchObject({ status: 409 });
    expect(capacity.reservedData("sanctum.moods")).toBe(256 * mebibyte);

    // Started, it's counted as the container it is.
    await capacity.started("sanctum.weather");
    expect(capacity.reservedData("sanctum.moods")).toBe(0);
    await expect(
      capacity.assertFits("sanctum.moods", 124, [
        { app: "sanctum.weather", memoryMb: 900 },
      ]),
    ).resolves.toBeUndefined();
  });

  it("lets a reservation go after 10 minutes", async () => {
    let at = 0;
    const { capacity } = await ledger({ now: () => at });
    await capacity.reserve(
      "sanctum.weather",
      { ...add, memoryMb: 900 },
      [],
      plenty,
    );

    at = 10 * 60_000;

    expect(await capacity.freeMb([])).toBe(1024);
  });

  it("replaces an app's reservation when it asks again", async () => {
    const { capacity } = await ledger();
    await capacity.reserve("sanctum.weather", add, [], plenty);
    await capacity.reserve("sanctum.weather", add, [], plenty);

    expect(await capacity.freeMb([])).toBe(1024 - 128);
  });
});

describe("its routes", () => {
  async function server() {
    const { capacity } = await ledger();
    const held = [moods];
    const stopped: unknown[] = [];
    const apps = {
      held: async () => held,
      stop: async (app: string, how: unknown) => {
        stopped.push([app, how]);
        return { app, state: "exited" };
      },
      ready: async () => true,
      memoryLimits: async () => true,
      reachesDevices: () => false,
    } as unknown as AppContainers;
    const images = {
      room: async () => 2 * gibibyte,
      // Weather's image was kept when it was removed.
      sizeMb: async (app: string) => (app === "sanctum.weather" ? 256 : 0),
    } as unknown as AppImages;
    const instance = createServer(
      { version: "dev-1" },
      {
        host: {
          docker: {} as never,
          updates: {} as UpdateService,
          apps,
          images,
          capacity,
        },
      },
    );
    return { instance, stopped, capacity };
  }

  it("says what's left, and reserves an add", async () => {
    const { instance } = await server();

    const before = await instance.inject({ url: "/api/apps/capacity" });
    const reserved = await instance.inject({
      method: "POST",
      url: "/api/apps/sanctum.weather/reservations",
      payload: add,
    });
    const after = await instance.inject({ url: "/api/apps/capacity" });
    const refused = await instance.inject({
      method: "POST",
      url: "/api/apps/sanctum.example/reservations",
      payload: { ...add, memoryMb: 1024 },
    });

    expect(before.json()).toEqual({
      memoryFreeMb: 1024 - 128,
      dataFreeBytes: 2 * gibibyte,
    });
    expect(reserved.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ memoryFreeMb: 1024 - 256 });
    expect(refused.statusCode).toBe(409);
    expect(
      (await instance.inject({ url: "/api/capabilities" })).json(),
    ).toMatchObject({ reserves: true });
  });

  it("stops an app turned off as such", async () => {
    const { instance, stopped } = await server();

    await instance.inject({
      method: "POST",
      url: "/api/apps/sanctum.moods/container/stop",
      payload: { off: true },
    });
    await instance.inject({
      method: "POST",
      url: "/api/apps/sanctum.moods/container/stop",
    });

    expect(stopped).toEqual([
      ["sanctum.moods", { off: true }],
      ["sanctum.moods", {}],
    ]);
  });
});
