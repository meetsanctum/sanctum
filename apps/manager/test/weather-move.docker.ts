import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realStack } from "./real-stack.js";

// Weather's move, for real: the real app from the real image, first in the core's
// process as a release before this ran it, then on its own with what it had. The
// steps of a first move are in app-move.docker.ts and the core's tests; what's here is
// that the real app and the real wiring get there.

const app = "sanctum.weather";
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

const info = async () =>
  ((await call("/api/apps")).body as Info[]).find(({ id }) => id === app)!;
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

describe("Weather's move, for real", () => {
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
    expect(await docker("exec", name("core"), "ls", "/data/apps")).toContain(
      `${app}.db`,
    );
  }, 300_000);

  it("moves when it's listed, keeping what it owns, on its own image", async () => {
    const before = (await entities()).map(({ key }) => key).sort();
    running[0] = `CORE_OFFICIAL_APPS_APART=${app}`;
    await docker("rm", "-f", name("manager"), name("core"));
    await startManager(coreImage, port);
    await coreIsUp();

    await waitFor("it to run on its own", async () => {
      const each = await info();
      return each.state === "running" && each.run ? true : undefined;
    });

    // The forecast may have come meanwhile, from the real Open-Meteo.
    expect((await entities()).map(({ key }) => key)).toEqual(
      expect.arrayContaining(before),
    );
    const volumes = await docker("volume", "ls", "--format", "{{.Name}}");
    expect(volumes).toContain(`sanctum-${stack}-app-data-${app}`);
    // Its file came with it: where the forecast is for, kept in its database.
    const rows = await docker(
      "exec",
      `sanctum-${stack}-app-${app}`,
      "node",
      "--no-warnings",
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync("/data/app.db", { readOnly: true });
       console.log(db.prepare("select location from forecast_location").all().length);`,
    );
    expect(rows).toBe("1");
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
    await waitFor("it to run on its own", async () => {
      const each = await info();
      return each.state === "running" && each.run ? true : undefined;
    });

    expect((await entities()).map(({ key }) => key)).toEqual(
      expect.arrayContaining(before),
    );
  }, 300_000);
});
