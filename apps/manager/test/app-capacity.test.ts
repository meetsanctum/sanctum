import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  options: {
    services?: string[];
    servicesWantedBy?: (app: string) => ReadonlySet<string>;
    dataDir?: string;
    now?: () => number;
  } = {},
) {
  const dataDir =
    options.dataDir ?? (await mkdtemp(join(tmpdir(), "sanctum-capacity-")));
  if (!options.dataDir) folders.push(dataDir);
  // 2 GiB keeps 1 GiB for the host, which leaves 1024 MB for apps.
  const capacity = createCapacity({
    dataDir,
    totalMemory: () => 2 * gibibyte,
    services: () => options.services ?? [],
    servicesWantedBy: options.servicesWantedBy,
    now: options.now,
  });
  return { capacity, dataDir };
}

const moods = { app: "sanctum.moods", memoryMb: 128, isRunning: false };
const add = { memoryMb: 128, dataMb: 256, services: [] };
const noImage = () => 0;
const plenty = {
  room: () => 10 * gibibyte,
  spare: () => 10 * gibibyte,
  sizeMb: noImage,
};

describe("what's left for apps", () => {
  it("counts every app held, the services that run and what's reserved", async () => {
    const { capacity } = await ledger({ services: ["mosquitto"] });
    await capacity.reserve("sanctum.weather", add, [moods], plenty);

    expect(await capacity.freeMb([moods])).toBe(1024 - 128 - 32 - 128);
    // An app's own count is left out of what's left for it.
    expect(
      await capacity.check("sanctum.weather", add, [moods], plenty),
    ).toMatchObject({ memoryFreeMb: 1024 - 128 - 32 });
  });

  it("gives back the room of an app turned off, kept across restarts", async () => {
    const { capacity, dataDir } = await ledger();
    await capacity.turnedOff("sanctum.moods");
    expect(await capacity.freeMb([moods])).toBe(1024);

    const again = await ledger({ dataDir });
    expect(await again.capacity.freeMb([moods])).toBe(1024);
    await again.capacity.turningOn("sanctum.moods");
    expect(await again.capacity.freeMb([moods])).toBe(1024 - 128);
  });

  it("reports freed room only once it has saved the Turn off", async () => {
    const { capacity, dataDir } = await ledger();
    expect(await capacity.freeMb([moods])).toBe(1024 - 128);
    const blocked = join(dataDir, "apps-off.json");
    await mkdir(blocked);

    await expect(capacity.turnedOff(moods.app)).rejects.toThrow();
    expect(await capacity.freeMb([moods])).toBe(1024 - 128);

    await rm(blocked, { recursive: true });
    await capacity.turnedOff(moods.app);
    expect(await capacity.freeMb([moods])).toBe(1024);
    expect(await capacity.freeMb([{ ...moods, isRunning: true }])).toBe(
      1024 - 128,
    );
  });
});

describe("reserving what an add needs", () => {
  it("refuses what doesn't fit, its services counted, saying what's left", async () => {
    const { capacity } = await ledger({ services: ["mosquitto"] });
    const held = [{ ...moods, memoryMb: 700 }];

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
      capacity.reserve("sanctum.weather", add, [], {
        ...plenty,
        room: () => 100 * mebibyte,
        spare: () => 100 * mebibyte,
      }),
    ).rejects.toThrow(
      "sanctum.weather needs 256 MB for its data, and only 100 MB can be spared",
    );
  });

  it("says how far short the disk is, though the room left stops at none", async () => {
    const { capacity } = await ledger();
    const short = {
      room: () => 0,
      spare: () => -900 * mebibyte,
      sizeMb: noImage,
    };

    await expect(
      capacity.check("sanctum.example", add, [], short),
    ).resolves.toMatchObject({
      dataNeedsMb: 256,
      dataFreeBytes: 0,
      dataShortBytes: (256 + 900) * mebibyte,
    });
    await expect(
      capacity.check("sanctum.example", add, [], plenty),
    ).resolves.toMatchObject({ dataShortBytes: 0 });
    await expect(
      capacity.check("sanctum.example", add, [], {
        room: () => null,
        spare: () => null,
        sizeMb: noImage,
      }),
    ).resolves.toMatchObject({ dataFreeBytes: null, dataShortBytes: null });
  });

  it("counts disk reservations once for available space and the shortfall", async () => {
    const { capacity } = await ledger();
    const spare = vi.fn(() => 100 * mebibyte).mockReturnValueOnce(-mebibyte);
    await expect(
      capacity.check("sanctum.example", add, [], {
        room: () => Math.max(0, spare()),
        spare,
        sizeMb: noImage,
      }),
    ).resolves.toMatchObject({
      dataFreeBytes: 0,
      dataShortBytes: 257 * mebibyte,
    });
    expect(spare).toHaveBeenCalledOnce();
  });

  it("asks no data of an image it kept, which its start uses as it is", async () => {
    const { capacity } = await ledger();
    const kept = { room: () => 0, spare: () => -mebibyte, sizeMb: () => 256 };

    await expect(
      capacity.check("sanctum.weather", { ...add, dataMb: 512 }, [], kept),
    ).resolves.toMatchObject({ dataNeedsMb: 0, dataShortBytes: 0 });
    await expect(
      capacity.reserve("sanctum.weather", { ...add, dataMb: 512 }, [], kept),
    ).resolves.toMatchObject({ id: expect.any(String) });
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
    expect(capacity.reservedData(noImage, "sanctum.moods")).toBe(
      256 * mebibyte,
    );

    // Started, it's counted as the container it is.
    capacity.started("sanctum.weather");
    expect(capacity.reservedData(noImage, "sanctum.moods")).toBe(0);
    await expect(
      capacity.assertFits("sanctum.moods", 124, [
        { app: "sanctum.weather", memoryMb: 900, isRunning: true },
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

  it("counts the broker and holds service memory until their requests arrive", async () => {
    const wanted: string[] = [];
    const wantedByZigbee = new Set<string>();
    const { capacity } = await ledger({
      services: wanted,
      servicesWantedBy: (app) =>
        app === "sanctum.zigbee" ? wantedByZigbee : new Set(),
    });
    const request = { ...add, services: ["zigbee2mqtt", "zigbee2mqtt"] };

    expect(
      await capacity.check("sanctum.zigbee", request, [], plenty),
    ).toMatchObject({
      memoryNeedsMb: 416,
      servicesMemoryMb: 288,
    });
    await capacity.reserve("sanctum.zigbee", request, [], plenty);
    const held = [{ app: "sanctum.zigbee", memoryMb: 128, isRunning: true }];
    expect(await capacity.freeMb(held)).toBe(1024 - 416);
    expect(capacity.reservedData(() => 256)).toBe(0);

    // A different app wanted the service when Zigbee's container started.
    wanted.push("mosquitto", "zigbee2mqtt");
    expect(
      await capacity.check("sanctum.zigbee", request, [], plenty),
    ).toMatchObject({ memoryNeedsMb: 128, servicesMemoryMb: 288 });
    capacity.started("sanctum.zigbee");
    expect(await capacity.freeMb(held)).toBe(1024 - 416);
    wanted.length = 0;
    expect(await capacity.freeMb(held)).toBe(1024 - 416);

    wanted.push("mosquitto", "zigbee2mqtt");
    for (const service of wanted) wantedByZigbee.add(service);
    expect(await capacity.freeMb(held)).toBe(1024 - 416);
    wantedByZigbee.clear();
    wanted.length = 0;
    expect(await capacity.freeMb(held)).toBe(1024 - 128);
  });
});

describe("its routes", () => {
  async function server(freeBytes = 2 * gibibyte) {
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
    // Weather's image was kept when it was removed.
    const sizeMb = (app: string) => (app === "sanctum.weather" ? 256 : 0);
    const images = {
      available: async () => ({
        room: (except?: string) =>
          Math.max(0, freeBytes - capacity.reservedData(sizeMb, except)),
        spare: (except?: string) =>
          freeBytes - capacity.reservedData(sizeMb, except),
        sizeMb,
      }),
    } as AppImages;
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

  it("checks what each app needs, crediting only its own retained image", async () => {
    const { instance } = await server(0);
    const checked = await instance.inject({
      method: "POST",
      url: "/api/apps/capacity",
      payload: [
        { app: "sanctum.weather", ...add },
        { app: "sanctum.zigbee", ...add, services: ["zigbee2mqtt"] },
      ],
    });
    expect(checked.json()).toEqual({
      "sanctum.weather": {
        memoryNeedsMb: 128,
        memoryFreeMb: 896,
        servicesMemoryMb: 0,
        dataNeedsMb: 0,
        dataFreeBytes: 0,
        dataShortBytes: 0,
      },
      "sanctum.zigbee": {
        memoryNeedsMb: 416,
        memoryFreeMb: 896,
        servicesMemoryMb: 288,
        dataNeedsMb: 256,
        dataFreeBytes: 0,
        dataShortBytes: 256 * mebibyte,
      },
    });
    const reserved = await instance.inject({
      method: "POST",
      url: "/api/apps/sanctum.weather/reservations",
      payload: add,
    });
    expect(reserved.statusCode).toBe(200);
  });

  it.each([
    { memoryMb: 500, dataMb: 256, freeBytes: 2 * gibibyte },
    { memoryMb: 128, dataMb: 256, freeBytes: 300 * mebibyte },
  ])(
    "serializes competing reservations with $memoryMb MB per app",
    async ({ memoryMb, dataMb, freeBytes }) => {
      const { instance } = await server(freeBytes);
      const results = await Promise.all(
        ["sanctum.zigbee", "sanctum.example"].map((app) =>
          instance.inject({
            method: "POST",
            url: `/api/apps/${app}/reservations`,
            payload: { ...add, memoryMb, dataMb },
          }),
        ),
      );
      expect(results.map((result) => result.statusCode).sort()).toEqual([
        200, 409,
      ]);
    },
  );

  it("releases only the reservation that was cancelled", async () => {
    const { instance, capacity } = await server();
    const url = "/api/apps/sanctum.weather/reservations";
    const reserve = () =>
      instance.inject({ method: "POST", url, payload: add });
    const cancel = (id: string) =>
      instance.inject({ method: "DELETE", url, payload: { id } });
    const first = await reserve();
    const second = await reserve();

    expect((await cancel(first.json().id)).statusCode).toBe(204);
    expect(await capacity.freeMb([])).toBe(1024 - 128);
    expect((await cancel(second.json().id)).statusCode).toBe(204);
    expect(await capacity.freeMb([])).toBe(1024);
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
