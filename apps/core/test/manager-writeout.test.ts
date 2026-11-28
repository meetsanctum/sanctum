import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createManagerClient, type ManagerClient } from "../src/manager.js";
import { createWriteoutFollower } from "../src/manager-writeout.js";

// Whether the host is writing out a backlog to its disks, as the core follows
// it from the manager's GET /api/host/writeout.

const mb = 1024 * 1024;
const writing = {
  pendingBytes: 800 * mb,
  thresholdBytes: 8 * mb,
};
const idle = {
  pendingBytes: 2 * mb,
  thresholdBytes: 8 * mb,
};

describe("following the host's writeout", () => {
  function follower(holdMs = 1_000) {
    const logs: string[] = [];
    let at = 0;
    const follow = createWriteoutFollower({
      log: (message) => logs.push(message),
      holdMs,
      now: () => at,
    });
    return { follow, logs, passes: (ms: number) => (at += ms) };
  }

  it("is idle until the manager says otherwise", () => {
    const { follow } = follower();

    expect(follow.writingOut()).toBe(false);
    follow.heard(idle);
    expect(follow.writingOut()).toBe(false);
  });

  it("logs once as a writeout begins and once as it ends", () => {
    const { follow, logs } = follower();

    follow.heard(writing);
    follow.heard(writing);
    expect(follow.writingOut()).toBe(true);
    follow.heard(idle);
    follow.heard(idle);

    expect(follow.writingOut()).toBe(false);
    expect(logs).toEqual([
      "host: writing out 800 MB to its disks, past 8 MB; apps get more time to answer",
      "host: done writing out to its disks",
    ]);
  });

  it("holds a writeout under way while the manager doesn't answer, for a while", () => {
    const { follow, logs, passes } = follower(1_000);
    follow.heard(writing);

    passes(900);
    follow.missed();
    expect(follow.writingOut()).toBe(true);

    passes(100);
    expect(follow.writingOut()).toBe(false);
    follow.missed();
    expect(logs.at(-1)).toBe(
      "host: done writing out to its disks, as far as the core knows: the manager hasn't answered for 1 s",
    );
  });

  it("holds nothing when it wasn't writing out", () => {
    const { follow, logs } = follower();

    follow.missed();

    expect(follow.writingOut()).toBe(false);
    expect(logs).toEqual([]);
  });

  it("takes a manager that can't say as idle", () => {
    const { follow } = follower();
    follow.heard(writing);

    follow.heard(null);

    expect(follow.writingOut()).toBe(false);
  });
});

describe("the manager client's writeout", () => {
  const open: { client: ManagerClient; server: Server }[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const { client, server } of open.splice(0)) {
      client.close();
      server.close();
      server.closeAllConnections();
    }
  });

  async function answering() {
    const socketPath = join(
      await mkdtemp(join(tmpdir(), "sanctum-")),
      "manager.sock",
    );
    const state = {
      status: 200,
      body: JSON.stringify(idle),
      asked: 0,
      hanging: false,
      disconnected: false,
    };
    const server = createServer((request, response) => {
      request.resume();
      if (request.url === "/api/host/writeout") state.asked += 1;
      if (state.hanging) {
        response.on("close", () => (state.disconnected = true));
        return;
      }
      response.statusCode = state.status;
      response.end(state.body);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const logs: string[] = [];
    const client = createManagerClient({
      socketPath,
      homeId: "home-1",
      log: (message) => logs.push(message),
      retry: { firstMs: 5, maxMs: 20 },
    });
    open.push({ client, server });
    return { client, state, logs };
  }

  it("follows what the manager says, and holds it while it answers with an error", async () => {
    const { client, state, logs } = await answering();
    let at = 0;
    vi.spyOn(performance, "now").mockImplementation(() => at);

    client.followWriteout(5, 1_000);
    await vi.waitFor(() => expect(state.asked).toBeGreaterThan(0));
    expect(client.writingOut()).toBe(false);

    state.body = JSON.stringify(writing);
    await vi.waitFor(() => expect(client.writingOut()).toBe(true));

    state.status = 503;
    const asked = state.asked;
    await vi.waitFor(() => expect(state.asked).toBeGreaterThan(asked + 1));
    expect(client.writingOut()).toBe(true);

    at += 1_000;
    await vi.waitFor(() =>
      expect(logs).toContain(
        "host: done writing out to its disks, as far as the core knows: the manager hasn't answered for 1 s",
      ),
    );
    expect(client.writingOut()).toBe(false);

    state.status = 200;
    await vi.waitFor(() => expect(client.writingOut()).toBe(true));
    // A stale flag from a manager reply cannot override the counters.
    state.body = JSON.stringify({ ...idle, writingOut: true });
    await vi.waitFor(() => expect(client.writingOut()).toBe(false));
  });

  it("cancels a request still under way when the link closes", async () => {
    const { client, state, logs } = await answering();
    state.hanging = true;
    client.followWriteout(60_000);
    await vi.waitFor(() => expect(state.asked).toBe(1));

    client.close();

    await vi.waitFor(() => expect(state.disconnected).toBe(true));
    expect(client.writingOut()).toBe(false);
    expect(logs).toEqual([]);
  });

  it("takes an old manager's not found as idle, and keeps asking", async () => {
    const { client, state } = await answering();
    state.body = JSON.stringify(writing);
    client.followWriteout(5);
    await vi.waitFor(() => expect(client.writingOut()).toBe(true));

    state.status = 404;
    state.body = JSON.stringify({ error: "Route not found" });

    await vi.waitFor(() => expect(client.writingOut()).toBe(false));
    const asked = state.asked;
    await vi.waitFor(() => expect(state.asked).toBeGreaterThan(asked));
  });

  it("is idle while not followed", async () => {
    const { client, state } = await answering();
    state.body = JSON.stringify(writing);

    expect(client.writingOut()).toBe(false);
    expect(state.asked).toBe(0);
  });
});
