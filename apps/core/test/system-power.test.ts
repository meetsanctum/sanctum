import type { ClientInfo } from "@meetsanctum/auth-protocol";
import { describe, expect, it } from "vitest";

import { ManagerRefusal, ManagerUnavailable } from "../src/manager.js";
import { openLive, personWithClient, settled } from "./devices-support.js";
import {
  claimed,
  fakeManager,
  get,
  managerSocket,
  post,
  sharedClient,
  testCore,
  type TestCore,
  type TestManager,
} from "./support.js";

// Settings → Status' last 24 hours, Restart and Shut down, Free up space and
// Connected now: every client, shared ones too, may ask; each request goes in
// the activity log, and every client hears of a restart or a shutdown before it
// happens.

async function core(manager: Partial<TestManager> = {}) {
  const fake = fakeManager();
  const core = await testCore({ manager: { ...fake.manager, ...manager } });
  const admin = await claimed(core);
  return { core, admin, calls: fake.calls };
}

// Oldest first.
const entries = (core: TestCore) =>
  core.activity
    .recent()
    .reverse()
    .filter((entry) => entry.action.startsWith("sanctum."))
    .map(({ action, outcome, reason, clientId, detail }) => ({
      action,
      outcome,
      reason,
      clientId,
      detail,
    }));

describe("the host's day", () => {
  it("is each 5 minutes the manager keeps, for every client", async () => {
    const { core: home } = await core();
    const response = await get(home, "/api/system/history", sharedClient(home));
    expect(response.statusCode).toBe(200);
    expect(response.json().points).toEqual([
      {
        at: "2026-11-02T18:10:00.000Z",
        usage: 0.62,
        celsius: 61.5,
        memoryUsed: 1_190_000_000,
      },
    ]);
  });

  it("is unavailable while the manager doesn't answer", async () => {
    const { core: home, admin } = await core({
      hostHistory: async () => {
        throw new ManagerUnavailable("The manager did not answer");
      },
    });
    const response = await get(home, "/api/system/history", admin);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "manager_unavailable" });
  });
});

describe("restart and shut down", () => {
  it("asks the manager, tells every client and goes in the activity log", async () => {
    const { core: home, admin, calls } = await core();
    const shared = sharedClient(home);
    const watching = await openLive(home, shared.token);

    const response = await post(home, "/api/system/restart", {}, shared);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ action: "restart" });
    await settled();

    expect(calls).toContain("POST restart");
    expect(watching.messages).toContainEqual({
      type: "system",
      going: "restart",
    });
    expect(entries(home)).toEqual([
      {
        action: "sanctum.restart",
        outcome: "ok",
        reason: null,
        clientId: shared.id,
        detail: null,
      },
    ]);

    await post(home, "/api/system/shutdown", {}, admin);
    expect(calls).toContain("POST shutdown");
    watching.socket.terminate();
  });

  it("is refused during an update, saying nothing to clients", async () => {
    const { core: home, admin } = await core({
      power: async () => {
        throw new ManagerRefusal("HTTP 409: An update is running", 409);
      },
    });
    const watching = await openLive(home, admin.token);
    const response = await post(home, "/api/system/shutdown", {}, admin);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "busy" });
    await settled();
    expect(
      watching.messages.filter((message) => message.type === "system"),
    ).toEqual([]);
    expect(entries(home)).toMatchObject([
      { action: "sanctum.shutdown", outcome: "refused", reason: "busy" },
    ]);
    watching.socket.terminate();
  });
});

describe("free up space", () => {
  it("says what it would remove and keep, and frees it", async () => {
    const { core: home, admin, calls } = await core();
    const plan = await get(home, "/api/system/space", admin);
    expect(plan.json()).toMatchObject({
      bytes: 1_300_000_000,
      devBuilds: 11,
      keeps: { running: "dev-ed4f70b", before: "dev-b7df8ce" },
    });

    const freed = await post(home, "/api/system/space/free", {}, admin);
    expect(freed.statusCode).toBe(200);
    expect(freed.json()).toEqual({ freed: 1_300_000_000 });
    expect(calls).toContain("POST space/free");
    expect(entries(home)).toMatchObject([
      {
        action: "sanctum.space.free",
        outcome: "ok",
        detail: { freed: 1_300_000_000 },
      },
    ]);
  });
});

describe("the manager's side", () => {
  it("is asked on its own routes, and a refusal stays one", async () => {
    const socket = await managerSocket(({ method, url }) => {
      if (url === "/api/host/history") {
        return { status: 200, body: { points: [] } };
      }
      if (url === "/api/host/restart") return { status: 202, body: {} };
      if (url === "/api/host/shutdown") {
        return { status: 409, body: { error: "An update is running" } };
      }
      if (method === "GET" && url === "/api/host/space") {
        return {
          status: 200,
          body: {
            bytes: 0,
            images: [],
            devBuilds: 0,
            keeps: { running: "1.2.3", before: null, newest: null },
          },
        };
      }
      return { status: 200, body: { freed: 512 } };
    });
    const { client } = socket;

    expect(await client.hostHistory()).toEqual({ points: [] });
    await client.power("restart");
    await expect(client.power("shutdown")).rejects.toBeInstanceOf(
      ManagerRefusal,
    );
    expect((await client.spacePlan()).keeps.running).toBe("1.2.3");
    expect(await client.freeSpace()).toEqual({ freed: 512 });
    expect(
      socket.received.map(({ method, url }) => `${method} ${url}`),
    ).toEqual([
      "GET /api/host/history",
      "POST /api/host/restart",
      "POST /api/host/shutdown",
      "GET /api/host/space",
      "POST /api/host/space/free",
    ]);
  });
});

describe("connected now", () => {
  it("says since when each client with a live connection has been connected", async () => {
    const { core: home, admin } = await core();
    const ben = personWithClient(home);
    const list = async () =>
      (await get(home, "/api/auth/clients", admin)).json() as ClientInfo[];

    expect(
      (await list()).every((client) => client.connectedSince === null),
    ).toBe(true);

    const first = await openLive(home, ben.token);
    const second = await openLive(home, ben.token);
    const connected = (await list()).find(
      (client) => client.id === ben.client.id,
    );
    expect(connected?.connectedSince).toBe("2026-10-26T12:00:00.000Z");

    first.socket.terminate();
    second.socket.terminate();
    await Promise.all([first.closed, second.closed]);
    await settled();
    expect(
      (await list()).find((client) => client.id === ben.client.id)
        ?.connectedSince,
    ).toBeNull();
  });
});
