import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realStack } from "./real-stack.js";

// The official apps' moves, for real: Weather, Natural light, Moods and Zigbee
// from the real image, each with what it was given, then the host as a release
// whose core ran them in its own process leaves it, and each moves to its own
// image with what it had. Then the same again with a first version that fails
// as it starts, for all four at once, and the version that works arriving with a
// power cut part way through. The steps of a first move are in app-move.docker.ts
// and the core's tests; what's here is that the real apps and the real wiring
// get there. With no stick here, the test says Zigbee2MQTT's device list on the
// broker in its place.

const app = "sanctum.weather";
const naturalLight = "sanctum.natural-light";
const moods = "sanctum.moods";
const zigbee = "sanctum.zigbee";
const apart = [app, naturalLight, moods, zigbee];
const {
  build,
  claim,
  coreImage,
  createVolumes,
  docker,
  freePort,
  imageId,
  managerLogs,
  name,
  run,
  stack,
  stagedFrom,
  startManager,
  turnBack,
  waitFor,
} = realStack("test-weather");

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

// Rows of a database, read in the container that has it open.
const rowsIn = async <T>(container: string, file: string, query: string) =>
  JSON.parse(
    await docker(
      "exec",
      container,
      "node",
      "--no-warnings",
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(${JSON.stringify(file)}, { readOnly: true });
       console.log(JSON.stringify(db.prepare(${JSON.stringify(query)}).all()));`,
    ),
  ) as T[];

// The keys of an app's jobs, as the core keeps them.
const jobsOf = async (id: string) =>
  (
    await rowsIn<{ key: string }>(
      name("core"),
      "/data/core.db",
      `select key from jobs where app = '${id}'`,
    )
  )
    .map(({ key }) => key)
    .sort();

// How many rows a table has in an app's own database, on its image.
const count = async (id: string, table: string) =>
  (
    await rowsIn(
      `sanctum-${stack}-app-${id}`,
      "/data/app.db",
      `select * from ${table}`,
    )
  ).length;

// The folder each app last committed from, which a first move sets.
const movedFrom = async () =>
  Object.fromEntries(
    (
      await rowsIn<{ app_id: string; folder: string | null }>(
        name("core"),
        "/data/core.db",
        "select app_id, folder from app_versions",
      )
    )
      .filter(({ app_id }) => apart.includes(app_id))
      .map(({ app_id, folder }) => [app_id, folder]),
  );

// The files a core that ran them in its own process left, read without the core.
const originalSums = () =>
  docker(
    "run",
    "--rm",
    "--volume",
    `${name("core-data")}:/core-data:ro`,
    "--entrypoint",
    "sh",
    `${name("manager")}:real`,
    "-c",
    "cd /core-data/apps && sha256sum *",
  );

// A version of each that fails as it starts, staged as an update brings one: its
// own package, with an entry whose start throws.
const stageFailing = (ids: readonly string[]) =>
  docker(
    "exec",
    name("manager"),
    "node",
    "-e",
    `const fs = require("node:fs");
     const { execFileSync } = require("node:child_process");
     const path = "/data/packages.json";
     const state = JSON.parse(fs.readFileSync(path, "utf8"));
     for (const id of ${JSON.stringify(ids)}) {
       const works = state.apps[id].current;
       const folder = works.version + "+fails";
       const at = (each) => "/data/packages/" + id + "/" + each;
       fs.rmSync(at(folder), { recursive: true, force: true });
       execFileSync("cp", ["-a", at(works.folder), at(folder)]);
       fs.writeFileSync(
         at(folder + "/dist/fails.js"),
         'import app from "./index.js";\\n' +
           "export default { ...app, async start() { throw new Error(\\"This version fails on purpose\\"); } };\\n",
       );
       const manifest = JSON.parse(fs.readFileSync(at(folder + "/package.json"), "utf8"));
       manifest.exports = { ".": "./dist/fails.js" };
       fs.writeFileSync(at(folder + "/package.json"), JSON.stringify(manifest));
       state.apps[id] = { current: { version: works.version, folder }, previous: works };
     }
     fs.writeFileSync(path, JSON.stringify(state));`,
  );

// The version that works, back as the next update.
const stageWorking = (ids: readonly string[]) =>
  docker(
    "exec",
    name("manager"),
    "node",
    "-e",
    `const fs = require("node:fs");
     const path = "/data/packages.json";
     const state = JSON.parse(fs.readFileSync(path, "utf8"));
     for (const id of ${JSON.stringify(ids)}) {
       const { current, previous } = state.apps[id];
       state.apps[id] = { current: previous, previous: current };
     }
     fs.writeFileSync(path, JSON.stringify(state));`,
  );

// Everything the stack runs stops at once, with no warning, and the host starts
// again as compose starts it.
async function powerCut() {
  const running = (
    await docker("ps", "-q", "--filter", `label=sanctum.stack=${stack}`)
  )
    .split("\n")
    .filter(Boolean);
  if (running.length > 0) await docker("kill", ...running);
  await docker("rm", "-f", name("manager"), name("core"));
}

// What the apps own in the home, as the core keeps it.
const whatTheHomeHas = async () => ({
  entities: Object.fromEntries(
    await Promise.all(
      apart.map(async (id) => [
        id,
        (await entities(id)).map(({ key }) => key).sort(),
      ]),
    ),
  ) as Record<string, string[]>,
  jobs: await jobsOf(moods),
});

// Zigbee2MQTT's device list, kept on the broker as Zigbee2MQTT keeps it, said
// with its own account, or none.
const listZigbeeDevices = async (list: string[] = ["-m", "[]"]) => {
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
    ...list,
  );
};
// None kept: an empty retained message takes the list away.
const forgetZigbeeDevices = () => listZigbeeDevices(["-n"]);

const at = (latitude: number) => ({
  timeZone: "Europe/Zurich",
  coordinates: { latitude, longitude: 8.5417 },
});

// Each app's container, by its id, which a container started afresh changes.
const containerIds = async () =>
  Object.fromEntries(
    await Promise.all(
      apart.map(async (id) => [
        id,
        await docker("inspect", "-f", "{{.Id}}", `sanctum-${stack}-app-${id}`),
      ]),
    ),
  ) as Record<string, string>;

const eachOnItsOwn = async () => {
  for (const id of apart) {
    await waitFor(`${id} to run on its own`, async () => {
      const each = await info(id);
      return each.state === "running" && each.run ? true : undefined;
    });
  }
};

// What each was given, in its own database on its own image.
async function itsFileCameWithIt() {
  // Where the forecast is for, kept in Weather's database.
  expect(await count(app, "forecast_location")).toBe(1);
  // The lights that follow the curve: none in a home without lights.
  expect(await count(naturalLight, "followed_lights")).toBe(0);
  // Moods' mood and its schedule.
  expect(await count(moods, "moods")).toBe(1);
  expect(await count(moods, "scheduled_moods")).toBe(1);
}

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

  it("runs each on its own from its first start, with what it's given", async () => {
    await listZigbeeDevices();
    await eachOnItsOwn();

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
  }, 300_000);

  it("moves each from a core that ran it in its own process, keeping what it owns, on its own image", async () => {
    const before = (await entities()).map(({ key }) => key).sort();
    const moodsBefore = (await entities(moods)).map(({ key }) => key);
    const jobsBefore = await jobsOf(moods);
    await turnBack(apart);
    const since = new Date().toISOString();
    await startManager(coreImage, port);
    await coreIsUp();
    await listZigbeeDevices();

    await eachOnItsOwn();

    // The forecast may have come meanwhile, from the real Open-Meteo.
    expect((await entities()).map(({ key }) => key)).toEqual(
      expect.arrayContaining(before),
    );
    const volumes = await docker("volume", "ls", "--format", "{{.Name}}");
    for (const id of apart) {
      expect(volumes).toContain(`sanctum-${stack}-app-data-${id}`);
    }
    // Each took in its file from the core's data, which stays until its next
    // update commits.
    const logs = await managerLogs(since);
    const originals = await docker("exec", name("core"), "ls", "/data/apps");
    for (const id of apart) {
      expect(logs).toContain(`adopt on ${id}'s app.db`);
      expect(originals).toContain(`${id}.db`);
    }
    // Each file came with it, on its own image.
    await itsFileCameWithIt();
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

  it("goes on in the container it ran in, its store of what it owns as it was, when the core starts again", async () => {
    const before = (await entities()).map(({ key }) => key);
    const containers = await containerIds();
    const restarted = new Date().toISOString();

    await docker("restart", name("core"));
    await coreIsUp();
    await eachOnItsOwn();

    expect((await entities()).map(({ key }) => key)).toEqual(
      expect.arrayContaining(before),
    );
    // Each went on in its own container, and resumed there: Zigbee kept its
    // session with the broker.
    expect(await containerIds()).toEqual(containers);
    expect(
      await run("sh", [
        "-c",
        `docker logs --since ${restarted} ${name("core")} 2>&1`,
      ]),
    ).not.toContain("sanctum.zigbee: connected to the broker");
    const since = await docker(
      "inspect",
      "-f",
      "{{.State.StartedAt}}",
      name("core"),
    );
    for (const id of apart) {
      const started = await docker(
        "inspect",
        "-f",
        "{{.State.StartedAt}}",
        `sanctum-${stack}-app-${id}`,
      );
      expect(Date.parse(started)).toBeLessThan(Date.parse(since));
    }
  }, 300_000);

  // The same home on the release before, once more, and this time the first
  // version each meets fails as it starts.
  let homeBefore: Awaited<ReturnType<typeof whatTheHomeHas>>;
  let originals: string;

  it("says each couldn't start when all four fail their first move together, its original as it was", async () => {
    homeBefore = await whatTheHomeHas();
    await stageFailing(apart);
    await turnBack(apart);
    originals = await originalSums();
    await startManager(coreImage, port);
    await coreIsUp();
    await listZigbeeDevices();

    // Each has its turn to take in its file, and none waits on another's
    // failing start for that.
    for (const id of apart) {
      await waitFor(`${id} to give up`, async () =>
        (await info(id)).state === "failed" ? true : undefined,
      );
    }

    expect(await movedFrom()).toEqual(
      Object.fromEntries(apart.map((id) => [id, null])),
    );
    expect(await originalSums()).toBe(originals);
    // What they own stays meanwhile, as for any app that fails.
    const home = await whatTheHomeHas();
    for (const id of apart) {
      expect(home.entities[id]).toEqual(
        expect.arrayContaining(homeBefore.entities[id]!),
      );
    }
    expect(home.jobs).toEqual(homeBefore.jobs);
  }, 600_000);

  it("moves each afresh from its original once a version that works arrives, through a power cut part way", async () => {
    await stageWorking(apart);
    // Zigbee waits for its device list this time, which holds up none of the
    // others, and the power goes while it waits: part way through its move.
    await forgetZigbeeDevices();
    const since = new Date().toISOString();
    await docker("restart", name("core"));
    await coreIsUp();
    await waitFor("the others to move", async () => {
      const folders = await movedFrom();
      return [app, naturalLight, moods].every((id) => folders[id])
        ? true
        : undefined;
    });
    await waitFor("Zigbee to wait for its list", async () =>
      (await info(zigbee)).state === "waiting" ? true : undefined,
    );
    expect((await movedFrom())[zigbee]).toBeNull();
    const beforeTheCut = await managerLogs(since);
    await powerCut();
    const after = new Date().toISOString();
    await startManager(coreImage, port);
    await coreIsUp();
    await listZigbeeDevices();

    await eachOnItsOwn();

    const folders = await movedFrom();
    const logs = beforeTheCut + (await managerLogs(after));
    for (const id of apart) {
      expect(folders[id]).toBeTruthy();
      expect(logs).toContain(`adopt on ${id}'s app.db`);
    }
    await itsFileCameWithIt();
    const home = await whatTheHomeHas();
    for (const id of apart) {
      expect(home.entities[id]).toEqual(
        expect.arrayContaining(homeBefore.entities[id]!),
      );
    }
    expect(home.jobs).toEqual(homeBefore.jobs);
    // Each original stays until its next update commits.
    expect(await originalSums()).toBe(originals);
  }, 600_000);
});
