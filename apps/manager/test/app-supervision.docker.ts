import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { realStack } from "./real-stack.js";

// A real core keeping a real app running in the real container the manager makes
// for it: one that really crashes, hangs and runs out of memory. How many
// failures it takes, and how long it pauses, are in the core's tests; what's here
// is what only real processes can show. The core reads the failures it remembers
// from memory, so each test begins by restarting it.

const app = "test.crasher";
const folder = "1.0.0+test";
const {
  api,
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
} = realStack("test-supervised", [`CORE_APPS_APART=${app}@${folder}`]);

// An app in a package of its own, with the real runner from the SDK's copy.
const code = `
import { defineAction, defineApp, NotReady } from "@meetsanctum/app-sdk";
import { existsSync, writeFileSync } from "node:fs";
import { z } from "zod";

const action = (id, run) =>
  defineAction({ id, title: id, tier: "write", input: z.object({}), output: z.unknown(), run });
const soon = (work) => setTimeout(work, 20);

export default defineApp({
  id: "${app}",
  name: "Crasher",
  version: "1.0.0",
  core: "^1.0.0",
  permissions: [],
  events: [],
  runtime: { memory: 64, data: 64 },
  actions: [
    action("crasher.ping", async () => "pong"),
    action("crasher.crash", async () => void soon(() => process.exit(3))),
    action("crasher.hang", async () => void soon(() => { for (;;); })),
    action("crasher.hog", async () => {
      const kept = [];
      setInterval(() => kept.push(Buffer.alloc(8 * 1024 * 1024, 1)), 5);
    }),
    action("crasher.waitNext", async () => {
      writeFileSync("/data/not-ready", "");
      soon(() => process.exit(3));
    }),
  ],
  async start() {
    if (existsSync("/data/not-ready")) throw new NotReady("Waiting for the test");
  },
});
`;

const makeManifest = `
import { toStaticManifest } from "@meetsanctum/app-sdk";
import { writeFileSync } from "node:fs";
const { default: app } = await import(process.cwd() + "/dist/index.js");
writeFileSync("sanctum-app.json", JSON.stringify(toStaticManifest(app)));
`;

let port: number;
let token: string;

// Its package: another app's dependencies, with its own code and manifest.
async function stagePackage(from: string) {
  const path = `/data/packages/${app}/${folder}`;
  const manager = name("manager");
  await docker("exec", manager, "mkdir", "-p", `/data/packages/${app}`);
  await docker("exec", manager, "cp", "-a", from, path);
  await docker(
    "exec",
    manager,
    "node",
    "-e",
    `const fs = require("node:fs");
     fs.rmSync(${JSON.stringify(`${path}/dist`)}, { recursive: true, force: true });
     fs.rmSync(${JSON.stringify(`${path}/migrations`)}, { recursive: true, force: true });
     fs.mkdirSync(${JSON.stringify(`${path}/dist`)});
     fs.writeFileSync(${JSON.stringify(`${path}/dist/index.js`)}, ${JSON.stringify(code)});
     fs.writeFileSync(${JSON.stringify(`${path}/package.json`)}, JSON.stringify({
       name: "test-crasher", version: "1.0.0", type: "module", exports: { ".": "./dist/index.js" },
     }));`,
  );
  await docker(
    "exec",
    "--workdir",
    path,
    manager,
    "node",
    "--no-warnings",
    "--input-type=module",
    "-e",
    makeManifest,
  );
}

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

type Info = {
  id: string;
  state: string;
  run?: { waitingFor?: string; failures?: number; lastFailure?: string };
};

const info = async () =>
  ((await call("/api/apps")).body as Info[]).find(({ id }) => id === app)!;

const until = (what: string, check: (each: Info) => boolean) =>
  waitFor(what, async () => {
    const each = await info();
    return check(each) ? each : undefined;
  });

const act = (action: string) =>
  call(`/api/apps/${app}/actions/crasher.${action}`, {});

// The container as the manager has it now, by when it started.
const containerStart = async () => {
  const { body } = await api("GET", `/api/apps/${app}/container`);
  return (body as { startedAt?: string }).startedAt;
};

// The core remembers failures in memory, so a restart begins each test afresh;
// it finds the container again as it finds any it left.
async function freshCore() {
  await docker("restart", name("core"));
  await waitFor("the core", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok ? true : undefined;
  });
  await until("the app to run", ({ state }) => state === "running");
}

describe("an app that really fails, in its real container", () => {
  // What the core and the manager saw, which a failure here needs to be understood.
  beforeEach(({ onTestFailed }) => {
    onTestFailed(async () => {
      for (const part of ["core", "manager"]) {
        const logs = await docker(
          "logs",
          "-t",
          "--tail",
          "60",
          name(part),
        ).catch(String);
        console.log(`--- the ${part} ---\n${logs}`);
      }
    });
  });

  beforeAll(async () => {
    await build("apps/core/Dockerfile", coreImage);
    await build("apps/manager/Dockerfile", `${name("manager")}:real`);
    await createVolumes();
    port = await freePort();
    await startManager(coreImage, port);
    const staged = await stagedFrom(await imageId(coreImage));
    const moods = staged.apps["sanctum.moods"]!.current.folder;
    await stagePackage(`/data/packages/sanctum.moods/${moods}`);
    await waitFor("the manager to run apps", async () => {
      const { body } = await api("GET", "/api/capabilities");
      return (body as { appContainers: boolean }).appContainers
        ? true
        : undefined;
    });
    await waitFor("the core", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok ? true : undefined;
    });
    token = await claim();
    await docker("restart", name("core"));
  }, 1_800_000);

  afterAll(async () => {
    await run("bash", ["deploy/dev/stack.sh", "down"], {
      SANCTUM_STACK: stack,
    }).catch(() => undefined);
  }, 120_000);

  it("runs it, in the container the manager makes, answering through its socket", async () => {
    await until("the app to run", ({ state }) => state === "running");

    expect(await act("ping")).toMatchObject({ status: 200, body: "pong" });
    expect((await api("GET", `/api/apps/${app}/container`)).body).toMatchObject(
      {
        state: "running",
        folder,
        memoryMb: 64,
      },
    );
    // What its settings show, as the kernel and Docker really give it.
    const { body } = await api("GET", `/api/apps/${app}/usage`);
    const usage = body as {
      memoryBytes: number;
      processor: number;
      dataBytes: number;
    };
    expect(usage.memoryBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(usage.memoryBytes).toBeLessThan(64 * 1024 * 1024);
    expect(usage.processor).toBeGreaterThanOrEqual(0);
    expect(usage.dataBytes).toBeGreaterThan(0);
  });

  it("restarts one that crashes, in a new process, and a call waits for it", async () => {
    await freshCore();
    const before = await containerStart();

    expect((await act("crash")).status).toBe(200);
    // Once the core knows, so this call waits rather than go out on a dying line.
    // The failure it counts stays, should a poll miss the moments it's down.
    await until(
      "the core to see it go",
      ({ state, run: running }) =>
        state !== "running" || running?.failures === 1,
    );
    const waited = await act("ping");

    expect(waited).toMatchObject({ status: 200, body: "pong" });
    const after = await until(
      "it to be back",
      ({ state, run: running }) =>
        state === "running" && running?.failures === 1,
    );
    expect(after.run?.lastFailure).toBe("crashed");
    expect(await containerStart()).not.toBe(before);
  });

  it("finds one that hangs by its heartbeat, and ends it", async () => {
    await freshCore();
    const before = await containerStart();

    expect((await act("hang")).status).toBe(200);

    const after = await until(
      "it to be back",
      ({ state, run: running }) =>
        state === "running" && running?.lastFailure === "hung",
    );
    expect(after.run?.failures).toBe(1);
    expect(await containerStart()).not.toBe(before);
    expect(await act("ping")).toMatchObject({ status: 200, body: "pong" });
  });

  it("says when one ran out of memory", async () => {
    await freshCore();

    expect((await act("hog")).status).toBe(200);

    const after = await until(
      "it to be back",
      ({ state, run: running }) =>
        state === "running" && running?.lastFailure === "out_of_memory",
    );
    expect(after.run?.failures).toBe(1);
    expect(await act("ping")).toMatchObject({ status: 200, body: "pong" });
  });

  it("counts one that stops before hello as a failed start in seconds, not a minute", async () => {
    await freshCore();
    // The package's own runner, which its container starts: without it, the next
    // process ends before it can say hello.
    const runner = `/data/packages/${app}/${folder}/node_modules/@meetsanctum/app-sdk/dist/runner.js`;
    await docker("exec", name("manager"), "mv", runner, `${runner}.away`);
    try {
      const crashed = Date.now();
      expect((await act("crash")).status).toBe(200);

      const failing = await until(
        "its next start to fail",
        ({ run: running }) => running?.lastFailure === "failed_start",
      );
      expect(Date.now() - crashed).toBeLessThan(20_000);
      expect(failing.run?.failures).toBe(2);
    } finally {
      await docker("exec", name("manager"), "mv", `${runner}.away`, runner);
    }
    await until("it to be back", ({ state }) => state === "running");
  }, 120_000);

  it("waits, without counting it, for what one says it waits for", async () => {
    await freshCore();

    expect((await act("waitNext")).status).toBe(200);
    const waiting = await until(
      "it to wait",
      ({ state }) => state === "waiting",
    );

    expect(waiting.run).toMatchObject({
      waitingFor: "Waiting for the test",
      failures: 1,
    });
    // In the same container, once what it waits for is there.
    const container = await docker(
      "ps",
      "--quiet",
      "--filter",
      `label=sanctum.stack=${stack}`,
      "--filter",
      `label=sanctum.app=${app}`,
    );
    await docker("exec", container, "unlink", "/data/not-ready");
    const running = await until(
      "it to run",
      ({ state }) => state === "running",
    );
    expect(running.run?.failures).toBe(1);
    expect(running.run?.waitingFor).toBeUndefined();
  });

  it("frees its memory while it's off, also after a restart, and comes back", async () => {
    await freshCore();
    const container = async () =>
      (await api("GET", `/api/apps/${app}/container`)).body as {
        state?: string;
      };
    const turn = (off: boolean) => call(`/api/apps/${app}/off`, { off });

    expect((await turn(true)).status).toBe(200);
    await waitFor("its container to stop", async () =>
      (await container()).state === "running" ? undefined : true,
    );
    expect((await info()).state).toBe("off");
    expect((await act("ping")).status).toBe(503);

    await docker("restart", name("core"));
    await waitFor("the core", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok ? true : undefined;
    });
    await until("the core to know it's off", ({ state }) => state === "off");
    expect((await container()).state).not.toBe("running");

    expect((await turn(false)).status).toBe(200);
    await until("it to run again", ({ state }) => state === "running");
    expect(await act("ping")).toMatchObject({ status: 200, body: "pong" });
    expect((await container()).state).toBe("running");
  }, 120_000);

  it("waits stopped in its container while a core update is on trial, and starts there at the commit", async () => {
    await freshCore();
    const health = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok
        ? ((await response.json()) as { updatePending?: boolean })
        : undefined;
    };
    const containerId = () =>
      docker("inspect", "-f", "{{.Id}}", name(`app-${app}`));
    const before = await containerId();

    // What a core update does: the marker, then a new core. Stopping the core
    // takes the app's connection: its runner stops it there and waits.
    await docker("exec", name("core"), "touch", "/data/update-pending");
    const since = new Date().toISOString();
    await docker("restart", name("core"));
    await waitFor("the core on trial", async () =>
      (await health())?.updatePending === true ? true : undefined,
    );
    await waitFor("the app to wait for the next core", async () =>
      (
        await run("sh", [
          "-c",
          `docker logs --since ${since} ${name(`app-${app}`)} 2>&1`,
        ])
      ).includes("waits for the next")
        ? true
        : undefined,
    );
    // Long enough for a launch to have shown.
    await new Promise((done) => setTimeout(done, 5_000));
    expect(await containerId()).toBe(before);

    await docker("exec", name("core"), "unlink", "/data/update-pending");
    await waitFor("the commit", async () =>
      (await health())?.updatePending === false ? true : undefined,
    );

    await until("it to run", ({ state }) => state === "running");
    expect(await act("ping")).toMatchObject({ status: 200, body: "pong" });
    expect(await containerId()).toBe(before);
  }, 120_000);

  it("stops it for good with the stack, leaving nothing", async () => {
    await run("bash", ["deploy/dev/stack.sh", "down"], {
      SANCTUM_STACK: stack,
    });

    expect(
      await docker(
        "ps",
        "-a",
        "--filter",
        `label=sanctum.stack=${stack}`,
        "--format",
        "{{.Names}}",
      ),
    ).toBe("");
  }, 120_000);
});
