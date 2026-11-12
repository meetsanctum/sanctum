import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realStack } from "./real-stack.js";

// The official apps' moves, for real: Weather, Natural light, Moods and Zigbee
// from the real image, first in the core's process as a release before this ran
// them, then each on its own with what it had. The steps of a first move are in
// app-move.docker.ts and the core's tests; what's here is that the real apps and
// the real wiring get there. With no stick here, the test says Zigbee2MQTT's
// device list on the broker in its place.

const app = "sanctum.weather";
const naturalLight = "sanctum.natural-light";
const moods = "sanctum.moods";
const zigbee = "sanctum.zigbee";
const apart = [app, naturalLight, moods, zigbee];
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
const entities = async (id = app) =>
  (await call(`/api/entities?app=${id}`)).body as Entity[];

const coreIsUp = () =>
  waitFor("the core", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok ? true : undefined;
  });

// The keys of an app's jobs, as the core keeps them.
const jobsOf = async (id: string) =>
  JSON.parse(
    await docker(
      "exec",
      name("core"),
      "node",
      "--no-warnings",
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync("/data/core.db", { readOnly: true });
       const rows = db.prepare("select key from jobs where app = ?").all("${id}");
       console.log(JSON.stringify(rows.map(({ key }) => key).sort()));`,
    ),
  ) as string[];

// Zigbee2MQTT's device list, kept on the broker as Zigbee2MQTT keeps it, said
// with its own account.
const listZigbeeDevices = async () => {
  const broker = `sanctum-${stack}-mosquitto`;
  await waitFor("the broker", async () =>
    (await docker("inspect", "-f", "{{.State.Running}}", broker).catch(
      () => "",
    )) === "true"
      ? true
      : undefined,
  );
  const services = JSON.parse(
    await docker("exec", name("manager"), "cat", "/data/services.json"),
  ) as { mqttAccounts: Record<string, { password: string }> };
  await docker(
    "exec",
    broker,
    "mosquitto_pub",
    "-h",
    "localhost",
    "-u",
    "zigbee2mqtt",
    "-P",
    services.mqttAccounts.zigbee2mqtt!.password,
    "-t",
    "zigbee2mqtt/bridge/devices",
    "-r",
    "-m",
    "[]",
  );
};

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
    // A room with a mood, from nine to five.
    const idOf = (response: { body: unknown }) =>
      (response.body as { id: string }).id;
    const office = idOf(
      await call("/api/places/rooms/add", { name: "Office" }),
    );
    const focus = idOf(
      await call(`/api/apps/${moods}/actions/moods.createMood`, {
        roomId: office,
        name: "Focus",
        lights: [{ device: "desk", capability: "light", state: { on: true } }],
      }),
    );
    const scheduled = await call(
      `/api/apps/${moods}/actions/moods.scheduleMood`,
      { roomId: office, moodId: focus, start: 540, end: 1020 },
    );
    expect(scheduled.status).toBe(200);
    expect(await jobsOf(moods)).toHaveLength(2);
    const files = await docker("exec", name("core"), "ls", "/data/apps");
    for (const id of apart) expect(files).toContain(`${id}.db`);
    await listZigbeeDevices();
  }, 300_000);

  it("moves when it's listed, keeping what it owns, on its own image", async () => {
    const before = (await entities()).map(({ key }) => key).sort();
    const moodsBefore = (await entities(moods)).map(({ key }) => key);
    const jobsBefore = await jobsOf(moods);
    running[0] = `CORE_OFFICIAL_APPS_APART=${apart.join(",")}`;
    await docker("rm", "-f", name("manager"), name("core"));
    await startManager(coreImage, port);
    await coreIsUp();

    for (const id of apart) {
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
    for (const id of apart) {
      expect(volumes).toContain(`sanctum-${stack}-app-data-${id}`);
    }
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
    // Moods' mood and its schedule, and the mood and jobs it says again it owns.
    expect(await count(moods, "moods")).toBe("1");
    expect(await count(moods, "scheduled_moods")).toBe("1");
    expect((await entities(moods)).map(({ key }) => key)).toEqual(moodsBefore);
    expect(await jobsOf(moods)).toEqual(jobsBefore);
    // Zigbee reaches the broker, and only the broker, on a network of its own
    // that reaches nothing beyond.
    const network = `sanctum-${stack}-app-${zigbee}-broker`;
    expect(
      await docker(
        "inspect",
        "-f",
        "{{.HostConfig.NetworkMode}}",
        `sanctum-${stack}-app-${zigbee}`,
      ),
    ).toBe(network);
    expect(
      await docker("network", "inspect", "-f", "{{.Internal}}", network),
    ).toBe("true");
    const onIt = await docker(
      "network",
      "inspect",
      "-f",
      "{{range .Containers}}{{.Name}} {{end}}",
      network,
    );
    expect(onIt.split(" ").filter(Boolean).sort()).toEqual(
      [`sanctum-${stack}-app-${zigbee}`, `sanctum-${stack}-mosquitto`].sort(),
    );
    // Every other app has no network at all.
    for (const id of [app, naturalLight, moods]) {
      expect(
        await docker(
          "inspect",
          "-f",
          "{{.HostConfig.NetworkMode}}",
          `sanctum-${stack}-app-${id}`,
        ),
      ).toBe("none");
    }
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
    for (const id of apart) {
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
