import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realStack } from "./real-stack.js";

// The official apps' moves, for real: Weather and Natural light from the real
// image, first in the core's process as a release before this ran them, then each
// on its own with what it had. The steps of a first move are in app-move.docker.ts
// and the core's tests; what's here is that the real apps and the real wiring get
// there.

const app = "sanctum.weather";
const naturalLight = "sanctum.natural-light";
const running: string[] = ["CORE_OFFICIAL_APPS_APART="];
const {
  build,
  claim,
  coreImage,
  createVolumes,
  docker,
  freePort,
  imageId,
  name,
  run,
  stack,
  stagedFrom,
  startManager,
  waitFor,
} = realStack("test-weather", running);

let port: number;
let token: string;

const call = async (path: string, body?: object) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

type Info = { id: string; state: string; run?: unknown };
type Entity = { key: string; state: unknown };

const info = async (id = app) =>
  ((await call("/api/apps")).body as Info[]).find((each) => each.id === id)!;
const entities = async () =>
  (await call(`/api/entities?app=${app}`)).body as Entity[];

const coreIsUp = () =>
  waitFor("the core", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok ? true : undefined;
  });

const at = (latitude: number) => ({
  timeZone: "Europe/Zurich",
  coordinates: { latitude, longitude: 8.5417 },
});

describe("the official apps' moves, for real", () => {
  beforeAll(async () => {
    await build("apps/core/Dockerfile", coreImage);
    await build("apps/manager/Dockerfile", `${name("manager")}:real`);
    await createVolumes();
    port = await freePort();
    await startManager(coreImage, port);
    await stagedFrom(await imageId(coreImage));
    await coreIsUp();
    token = await claim();
    await docker("restart", name("core"));
    await coreIsUp();
  }, 1_800_000);

  afterAll(async () => {
    await run("bash", ["deploy/dev/stack.sh", "down"], {
      SANCTUM_STACK: stack,
    }).catch(() => undefined);
  }, 120_000);

  it("runs in the core's process while it isn't listed, with its file there", async () => {
    await waitFor("it to run", async () => {
      const each = await info();
      return each.state === "running" ? true : undefined;
    });
    expect((await info()).run).toBeUndefined();

    await call("/api/places/home/update", at(47.3769));

    await waitFor("its sun and card", async () =>
      (await entities()).length >= 2 ? true : undefined,
    );
    const files = await docker("exec", name("core"), "ls", "/data/apps");
    expect(files).toContain(`${app}.db`);
    expect(files).toContain(`${naturalLight}.db`);
  }, 300_000);

  it("moves when it's listed, keeping what it owns, on its own image", async () => {
    const before = (await entities()).map(({ key }) => key).sort();
    running[0] = `CORE_OFFICIAL_APPS_APART=${app},${naturalLight}`;
    await docker("rm", "-f", name("manager"), name("core"));
    await startManager(coreImage, port);
    await coreIsUp();

    for (const id of [app, naturalLight]) {
      await waitFor(`${id} to run on its own`, async () => {
        const each = await info(id);
        return each.state === "running" && each.run ? true : undefined;
      });
    }

    // The forecast may have come meanwhile, from the real Open-Meteo.
    expect((await entities()).map(({ key }) => key)).toEqual(
      expect.arrayContaining(before),
    );
    const volumes = await docker("volume", "ls", "--format", "{{.Name}}");
    expect(volumes).toContain(`sanctum-${stack}-app-data-${app}`);
    expect(volumes).toContain(`sanctum-${stack}-app-data-${naturalLight}`);
    // Each file came with it, on its own image.
    const count = (id: string, table: string) =>
      docker(
        "exec",
        `sanctum-${stack}-app-${id}`,
        "node",
        "--no-warnings",
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from "node:sqlite";
         const db = new DatabaseSync("/data/app.db", { readOnly: true });
         console.log(db.prepare("select * from ${table}").all().length);`,
      );
    // Where the forecast is for, kept in Weather's database.
    expect(await count(app, "forecast_location")).toBe("1");
    // The lights that follow the curve: none in a home without lights.
    expect(await count(naturalLight, "followed_lights")).toBe("0");
  }, 300_000);

  it("hears at once that the home has moved, through its socket", async () => {
    const sun = async () =>
      JSON.stringify(
        (await entities()).find(({ key }) => key === "sun")?.state,
      );
    const before = await sun();

    await call("/api/places/home/update", at(60));

    await waitFor("the sun to move", async () =>
      (await sun()) !== before ? true : undefined,
    );
  }, 60_000);

  it("stays on its own, its store of what it owns as it was, when the core starts again", async () => {
    const before = (await entities()).map(({ key }) => key);

    await docker("restart", name("core"));
    await coreIsUp();
    for (const id of [app, naturalLight]) {
      await waitFor(`${id} to run on its own`, async () => {
        const each = await info(id);
        return each.state === "running" && each.run ? true : undefined;
      });
    }

    expect((await entities()).map(({ key }) => key)).toEqual(
      expect.arrayContaining(before),
    );
  }, 300_000);
});
