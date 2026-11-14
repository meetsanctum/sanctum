import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createManagerClient, type ManagerClient } from "../src/manager.js";

type Received = { method?: string; url?: string; body: unknown };

// A manager listening on a Unix socket, answering with `status`, and with
// the host's id when asked for it.
function listen(socketPath: string, status = 204) {
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
    });
  });

  it("learns what a new manager says", async () => {
    const { client, logs, socketPath } = await setUp();
    await answering(socketPath);

    client.followCapabilities(5);

    // One that doesn't say whether it looks for devices doesn't.
    await vi.waitFor(() =>
      expect(client.capabilities()).toEqual({
        appContainers: true,
        memoryLimits: true,
        discovery: false,
      }),
    );
    expect(logs).toContain("manager: can run apps");
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

  it("keeps asking a manager that does not know the host's id yet", async () => {
    const { client, socketPath } = await setUp();
    const { server, received } = await listen(socketPath, 404);
    open.push({ server });

    client.learnHostId();

    await vi.waitFor(() => expect(received.length).toBeGreaterThan(2));
    expect(client.hostId()).toBeUndefined();
  });
});
