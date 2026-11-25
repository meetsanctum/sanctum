import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createManagerClient,
  ManagerRefusal,
  ManagerUnavailable,
  type ManagerClient,
} from "../src/manager.js";
import { piStatus } from "./manager-support.js";

type Received = { method?: string; url?: string; body: unknown };

// A manager listening on a Unix socket, answering with `status`, and with
// the host's id when asked for it.
function listen(socketPath: string, status = 204, putAnswer?: object) {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({
        method: request.method,
        url: request.url,
        body: body ? JSON.parse(body) : undefined,
      });
      if (request.method === "GET" && status < 300) {
        response.statusCode = 200;
        response.end(JSON.stringify({ id: "host-1" }));
      } else if (request.method === "PUT" && putAnswer) {
        response.statusCode = 200;
        response.end(JSON.stringify(putAnswer));
      } else {
        response.statusCode = status;
        response.end();
      }
    });
  });
  return new Promise<{ server: Server; received: Received[] }>((resolve) =>
    server.listen(socketPath, () => resolve({ server, received })),
  );
}

const open: { client?: ManagerClient; server?: Server }[] = [];
afterEach(() => {
  for (const { client, server } of open.splice(0)) {
    client?.close();
    server?.close();
  }
});

async function setUp() {
  const socketPath = join(
    await mkdtemp(join(tmpdir(), "sanctum-")),
    "manager.sock",
  );
  const logs: string[] = [];
  const client = createManagerClient({
    socketPath,
    homeId: "home-1",
    log: (message) => logs.push(message),
    retry: { firstMs: 5, maxMs: 20 },
  });
  open.push({ client });
  return { client, logs, socketPath };
}

describe("what apps read of the host", () => {
  it("uses the resources view and still reads a full answer from an older manager", async () => {
    const { client, socketPath } = await setUp();
    const urls: (string | undefined)[] = [];
    let answer: unknown = {
      model: null,
      processor: { name: "Intel(R) N150", cores: 4, matrixInstructions: true },
      memory: null,
      storage: null,
    };
    const server = createServer((request, response) => {
      urls.push(request.url);
      response.end(JSON.stringify(answer));
    });
    open.push({ server });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    expect(await client.hostResources()).toEqual({
      processor: { name: "Intel(R) N150", cores: 4, matrixInstructions: true },
      memory: null,
      storage: null,
    });
    answer = piStatus();
    expect(await client.hostResources()).toEqual({
      processor: {
        name: "Raspberry Pi 4 Model B",
        cores: 4,
        matrixInstructions: null,
      },
      memory: { totalBytes: 8_199_577_600, availableBytes: 7_542_419_456 },
      storage: { freeBytes: 6_917_287_936 },
    });
    expect(urls).toEqual([
      "/api/host/status?view=resources",
      "/api/host/status?view=resources",
    ]);
  });
});

describe("what the manager can do", () => {
  // A manager answering one question, with whatever the test has decided.
  async function answering(socketPath: string) {
    const state = {
      status: 200,
      body: JSON.stringify({ appContainers: true, memoryLimits: true }),
      asked: 0,
    };
    const server = createServer((request, response) => {
      request.resume();
      if (request.url === "/api/capabilities") state.asked += 1;
      response.statusCode = state.status;
      response.end(state.body);
    });
    open.push({ server });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return state;
  }

  it("is nothing until asked", async () => {
    const { client } = await setUp();

    expect(client.capabilities()).toEqual({
      appContainers: false,
      memoryLimits: false,
      discovery: false,
      lan: false,
      portRanges: false,
      deletesData: false,
      reserves: false,
    });
  });

  it("learns what a new manager says", async () => {
    const { client, logs, socketPath } = await setUp();
    await answering(socketPath);

    client.followCapabilities(5);

    // One that doesn't say whether it looks for devices, gives apps that
    // reach them a network of their own, or takes ranges of ports in its
    // rules, does none of it.
    await vi.waitFor(() =>
      expect(client.capabilities()).toEqual({
        appContainers: true,
        memoryLimits: true,
        discovery: false,
        lan: false,
        portRanges: false,
        deletesData: false,
        reserves: false,
      }),
    );
    expect(logs).toContain("manager: can run apps");
  });

  it("learns port range support after an upgrade, and only with LAN support", async () => {
    const { client, socketPath } = await setUp();
    const manager = await answering(socketPath);
    const base = { appContainers: true, memoryLimits: true };
    manager.body = JSON.stringify({ ...base, lan: true });
    client.followCapabilities(5);
    await vi.waitFor(() =>
      expect(client.capabilities()).toMatchObject({
        lan: true,
        portRanges: false,
      }),
    );

    manager.body = JSON.stringify({ ...base, lan: true, portRanges: true });
    await vi.waitFor(() =>
      expect(client.capabilities()).toMatchObject({
        lan: true,
        portRanges: true,
      }),
    );

    manager.body = JSON.stringify({ ...base, lan: false, portRanges: true });
    await vi.waitFor(() =>
      expect(client.capabilities()).toMatchObject({
        lan: false,
        portRanges: false,
      }),
    );
  });

  it("takes an old manager's not found as nothing yet, and keeps asking", async () => {
    const { client, socketPath } = await setUp();
    const manager = await answering(socketPath);
    manager.status = 404;
    manager.body = JSON.stringify({ error: "Route not found" });

    client.followCapabilities(5);
    await vi.waitFor(() => expect(manager.asked).toBeGreaterThan(1));
    expect(client.capabilities().appContainers).toBe(false);

    // The same update's manager step arrives.
    manager.status = 200;
    manager.body = JSON.stringify({ appContainers: true, memoryLimits: true });
    await vi.waitFor(() =>
      expect(client.capabilities().appContainers).toBe(true),
    );
  });

  it("keeps what it knew while the manager doesn't answer", async () => {
    const { client, socketPath } = await setUp();
    const manager = await answering(socketPath);
    client.followCapabilities(5);
    await vi.waitFor(() =>
      expect(client.capabilities().appContainers).toBe(true),
    );

    manager.status = 503;
    const asked = manager.asked;
    await vi.waitFor(() => expect(manager.asked).toBeGreaterThan(asked + 1));

    expect(client.capabilities().appContainers).toBe(true);
  });

  it("goes back to nothing when a manager goes back", async () => {
    const { client, logs, socketPath } = await setUp();
    const manager = await answering(socketPath);
    client.followCapabilities(5);
    await vi.waitFor(() =>
      expect(client.capabilities().appContainers).toBe(true),
    );

    manager.status = 404;

    await vi.waitFor(() =>
      expect(client.capabilities().appContainers).toBe(false),
    );
    expect(logs).toContain("manager: can't run apps yet");
  });

  it("stops asking once the client closes", async () => {
    const { client, socketPath } = await setUp();
    const manager = await answering(socketPath);
    client.followCapabilities(5);
    await vi.waitFor(() => expect(manager.asked).toBeGreaterThan(0));

    client.close();
    const asked = manager.asked;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(manager.asked).toBeLessThanOrEqual(asked + 1);
  });

  it("lets the process exit when closed while a capability answer is in flight", async () => {
    const { socketPath } = await setUp();
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import { createServer } from "node:http";
       import { createManagerClient } from ${JSON.stringify(new URL("../src/manager.ts", import.meta.url).href)};
       const manager = createManagerClient({
         socketPath: ${JSON.stringify(socketPath)}, homeId: "home-1", log: () => {},
       });
       const server = createServer((request, response) => {
         request.resume();
         manager.close();
         response.end(JSON.stringify({ appContainers: true, memoryLimits: true }));
         server.close(() => console.log("closed"));
       });
       server.listen(${JSON.stringify(socketPath)}, () => manager.followCapabilities());`,
    ]);
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.resume();
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    try {
      await vi.waitFor(() => expect(output).toContain("closed"), {
        timeout: 10_000,
      });
      await vi.waitFor(() => expect(child.exitCode).toBe(0), {
        timeout: 2_000,
      });
    } finally {
      child.kill();
      await exited;
    }
  }, 20_000);
});

describe("what's staged for this core", () => {
  const answering = async (
    answers: { status: number; body?: unknown }[],
    retryMs = 1,
  ) => {
    const socketPath = join(
      await mkdtemp(join(tmpdir(), "sanctum-")),
      "manager.sock",
    );
    const logs: string[] = [];
    const client = createManagerClient({
      socketPath,
      homeId: "home-1",
      log: (message) => logs.push(message),
      retry: { firstMs: retryMs, maxMs: retryMs },
    });
    const server = createServer((request, response) => {
      request.resume();
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
      response.statusCode = answer.status;
      response.end(answer.body ? JSON.stringify(answer.body) : undefined);
    });
    await new Promise<void>((done) => server.listen(socketPath, done));
    open.push({ client, server });
    return { client, logs };
  };
  const weather = {
    "sanctum.weather": { version: "0.3.0", folder: "0.3.0+abc" },
  };

  it("is what the manager says", async () => {
    const { client } = await answering([
      { status: 200, body: { apps: weather } },
    ]);

    expect(await client.stagedApps()).toEqual(weather);
  });

  it("is nothing from an old manager, which doesn't know the question", async () => {
    const { client, logs } = await answering([{ status: 404 }]);

    expect(await client.stagedApps()).toEqual({});
    expect(logs.join("\n")).toContain("no staged apps");
  });

  it("asks again while the manager can't answer yet", async () => {
    const { client } = await answering([
      { status: 503 },
      { status: 500 },
      { status: 200, body: { apps: weather } },
    ]);

    expect(await client.stagedApps()).toEqual(weather);
  });

  it("gives up in the end, so the apps can start", async () => {
    const { client } = await answering([{ status: 503 }]);

    expect(await client.stagedApps(5)).toEqual({});
  });

  it("reports a failed lookup when the caller needs a definite answer", async () => {
    // A pause before asking again that outlasts the time left makes the
    // first 503 the answer.
    const { client } = await answering(
      [{ status: 503, body: { error: "Staging is under way" } }],
      10_000,
    );

    await expect(
      client.stagedApps(2_000, { requireAnswer: true }),
    ).rejects.toThrow("Staging is under way");
  });

  it("does not ask again after its startup budget expires during a retry pause", async () => {
    const { client } = await answering(
      [{ status: 503 }, { status: 200, body: { apps: weather } }],
      30,
    );

    expect(await client.stagedApps(10)).toEqual({});
  });
});

describe("the manager client", () => {
  it("keeps startup alive while waiting for the manager", async () => {
    const { socketPath } = await setUp();
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import { createManagerClient } from ${JSON.stringify(new URL("../src/manager.ts", import.meta.url).href)};
       const manager = createManagerClient({
         socketPath: ${JSON.stringify(socketPath)}, homeId: "home-1",
         log: console.log,
         retry: { firstMs: 50, maxMs: 50 },
       });
       await manager.reportClaimed(false);
       manager.close();
       console.log("reported");`,
    ]);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.resume();
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    try {
      // Starting Node with the tsx loader can take seconds on a busy runner.
      await vi.waitFor(() => expect(output).toContain("manager: waiting"), {
        timeout: 10_000,
      });
      // The child has no server yet; only its retry should keep it alive.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const { server } = await listen(socketPath);
      open.push({ server });
      expect(await exited).toBe(0);
      expect(output).toContain("reported");
    } finally {
      child.kill();
      await exited;
    }
  }, 20_000);

  it("reports the claimed state once the manager answers", async () => {
    const { client, logs, socketPath } = await setUp();

    client.reportClaimed(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const { server, received } = await listen(socketPath);
    open.push({ server });

    await vi.waitFor(() =>
      expect(received).toEqual([
        {
          method: "PUT",
          url: "/api/claimed",
          body: { claimed: false, homeId: "home-1" },
        },
      ]),
    );
    expect(logs[0]).toMatch(/^manager: waiting for /);
  });

  it("sends the latest state", async () => {
    const { client, socketPath } = await setUp();
    const { server, received } = await listen(socketPath);
    open.push({ server });

    client.reportClaimed(false);
    client.reportClaimed(true);

    await vi.waitFor(() =>
      expect(received.at(-1)).toMatchObject({ body: { claimed: true } }),
    );
  });

  it("resolves once the latest state is reported", async () => {
    const { client, socketPath } = await setUp();
    const reported = client.reportClaimed(false);
    client.reportClaimed(true);
    const { server, received } = await listen(socketPath);
    open.push({ server });

    await reported;
    expect(received.at(-1)).toMatchObject({ body: { claimed: true } });
  });

  it("never lets a claim replace an unclaimed report the manager has not had", async () => {
    const { client, socketPath } = await setUp();
    const reported = client.reportClaimed(false);
    client.reportClaimed(true);
    const { server, received } = await listen(socketPath);
    open.push({ server });

    await reported;
    await vi.waitFor(() =>
      expect(
        received.map((r) => (r.body as { claimed: boolean }).claimed),
      ).toEqual([false, true]),
    );
  });

  it("keeps trying while the manager refuses", async () => {
    const { client, socketPath } = await setUp();
    const { server, received } = await listen(socketPath, 503);
    open.push({ server });

    client.reportClaimed(true);

    await vi.waitFor(() => expect(received.length).toBeGreaterThan(2));
  });

  it("stops asking a manager that keeps failing once the caller gives up", async () => {
    const { client, socketPath } = await setUp();
    const { server, received } = await listen(socketPath, 503);
    open.push({ server });
    const giveUp = new AbortController();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const releasing = client.releaseService("mosquitto", "sanctum.example", {
      signal: giveUp.signal,
    });
    const result = expect(releasing).rejects.toBeInstanceOf(ManagerUnavailable);

    try {
      // Let the second failure reach the client and leave the next retry pending.
      await vi.waitFor(
        () => {
          expect(received).toHaveLength(2);
          expect(vi.getTimerCount()).toBe(1);
        },
        { interval: 1 },
      );
      giveUp.abort();

      expect(vi.getTimerCount()).toBe(0);
      await result;
    } finally {
      giveUp.abort();
      client.close();
      vi.useRealTimers();
      await result;
    }
  });

  it.each(["lookup", "release"])(
    "closes an in-flight service %s when the caller gives up",
    async (operation) => {
      const { client, socketPath } = await setUp();
      const received = vi.fn();
      const disconnected = vi.fn();
      const server = createServer((request, response) => {
        request.resume();
        response.on("close", disconnected);
        received();
      });
      open.push({ server });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const giveUp = new AbortController();
      const options = { signal: giveUp.signal };
      const app = "sanctum.example";
      const pending =
        operation === "lookup"
          ? client.servicesHeldBy(app, options)
          : client.releaseService("mosquitto", app, options);
      const result = expect(pending).rejects.toBeInstanceOf(ManagerUnavailable);

      try {
        await vi.waitFor(() => expect(received).toHaveBeenCalled());
        giveUp.abort();
        await vi.waitFor(() => expect(disconnected).toHaveBeenCalled(), {
          timeout: 500,
        });
      } finally {
        server.closeAllConnections();
        await result;
      }
    },
  );

  it("learns the host's id once the manager answers", async () => {
    const { client, socketPath } = await setUp();

    client.learnHostId();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.hostId()).toBeUndefined();
    const { server, received } = await listen(socketPath);
    open.push({ server });

    await vi.waitFor(() => expect(client.hostId()).toBe("host-1"));
    expect(received).toEqual([
      { method: "GET", url: "/api/host", body: undefined },
    ]);
  });

  it("asks the manager to keep and release Piper for the core", async () => {
    const { client, socketPath } = await setUp();
    const { server, received } = await listen(socketPath, 204, {
      service: { name: "piper", apps: [], core: true, state: "starting" },
    });
    open.push({ server });

    await expect(client.wantServiceForCore("piper")).resolves.toBeUndefined();
    await expect(
      client.releaseServiceForCore("piper"),
    ).resolves.toBeUndefined();
    expect(received).toEqual([
      { method: "PUT", url: "/api/services/piper/core", body: undefined },
      { method: "DELETE", url: "/api/services/piper/core", body: undefined },
    ]);
  });

  it("keeps asking a manager that does not know the host's id yet", async () => {
    const { client, socketPath } = await setUp();
    const { server, received } = await listen(socketPath, 404);
    open.push({ server });

    client.learnHostId();

    await vi.waitFor(() => expect(received.length).toBeGreaterThan(2));
    expect(client.hostId()).toBeUndefined();
  });
});

describe("an app's network policy", () => {
  // A manager that made holder h1 for the app's container, and loads the
  // policies meant for it.
  async function holding(socketPath: string) {
    const received: Received[] = [];
    const server = createServer((request, response) => {
      let text = "";
      request.on("data", (chunk) => (text += chunk));
      request.on("end", () => {
        const body = JSON.parse(text);
        received.push({ method: request.method, url: request.url, body });
        const started = request.url === "/api/apps/sanctum.example/container";
        const { core, count, holder } = started ? body.lan : body;
        if (started || holder === "h1") {
          response.statusCode = 200;
          const loaded = { core, count, manager: "m1", holder: "h1" };
          response.end(
            JSON.stringify(started ? { kept: false, lan: loaded } : loaded),
          );
        } else {
          response.statusCode = 409;
          response.end(
            JSON.stringify({ error: "That holder isn't the app's" }),
          );
        }
      });
    });
    open.push({ server });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return received;
  }

  it("comes with a start, and each change goes to the holder it names", async () => {
    const { client, socketPath } = await setUp();
    const received = await holding(socketPath);
    const policy = {
      core: "c1",
      count: 1,
      addresses: ["192.168.1.40"],
      ports: [6053],
    };

    expect(
      await client.startAppContainer("sanctum.example", {
        folder: "1.0.0+test",
        memoryMb: 128,
        dataMb: 64,
        lan: policy,
      }),
    ).toEqual({
      kept: false,
      lan: { core: "c1", count: 1, manager: "m1", holder: "h1" },
    });
    expect(
      await client.applyLanPolicy("sanctum.example", {
        ...policy,
        count: 2,
        manager: "m1",
        holder: "h1",
      }),
    ).toEqual({ core: "c1", count: 2, manager: "m1", holder: "h1" });
    // One for a holder the app's container no longer has is refused.
    await expect(
      client.applyLanPolicy("sanctum.example", {
        ...policy,
        count: 3,
        manager: "m1",
        holder: "h0",
      }),
    ).rejects.toBeInstanceOf(ManagerRefusal);

    expect(received.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "PUT /api/apps/sanctum.example/container",
      "PUT /api/apps/sanctum.example/container/lan",
      "PUT /api/apps/sanctum.example/container/lan",
    ]);
    expect(received[0]!.body).toMatchObject({ lan: policy });
  });
});
