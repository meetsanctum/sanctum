import { describe, expect, it } from "vitest";

import { personWithClient } from "./devices-support.js";
import {
  claimed,
  get,
  managerSocket,
  post,
  sharedClient,
  testCore,
  type SocketRequest,
  type TestCore,
} from "./support.js";

// Updates from Settings → System: the core passes a request to the manager over
// its socket and reports its journal back. Every client may, shared ones too.

const journal = (changes: object = {}) => ({
  id: "a1b2c3d4",
  version: "dev-5e6f7a8",
  startedAt: "2026-10-28T10:00:00.000Z",
  phase: "core",
  core: {
    status: "checking",
    image: "localhost:5000/sanctum-core:dev-5e6f7a8",
    imageId: "sha256:core-new",
    fromVersion: "dev-1a2b3c4",
    previousContainerId: "c0ffee",
    backup: "/data/backups/core-20261028T100000-dev-1a2b3c4",
  },
  manager: {
    status: "pending",
    image: "localhost:5000/sanctum-manager:dev-5e6f7a8",
  },
  log: [
    { at: "2026-10-28T10:00:00.000Z", message: "Updating to dev-5e6f7a8" },
    {
      at: "2026-10-28T10:00:20.000Z",
      message: "Checking the new core's health",
    },
  ],
  ...changes,
});

// A manager that answers like the real one, from `state`.
async function host(
  state: {
    journal?: object | null;
    start?: { status: number; body: object };
    versions?: { status: number; body: object };
  } = {},
) {
  const socket = await managerSocket((request: SocketRequest) => {
    if (request.method === "GET" && request.url === "/api/update") {
      return {
        status: 200,
        body: { channel: "dev", update: state.journal ?? null },
      };
    }
    if (request.url === "/api/update/versions") {
      return (
        state.versions ?? {
          status: 200,
          body: {
            channel: "dev",
            versions: [
              { version: "dev-5e6f7a8", builtAt: "2026-10-28T09:00:00Z" },
              { version: "dev-1a2b3c4", builtAt: "2026-10-27T09:00:00Z" },
            ],
          },
        }
      );
    }
    if (request.method === "POST" && request.url === "/api/update") {
      return state.start ?? { status: 202, body: { update: journal() } };
    }
    return { status: 404, body: { error: "Not found" } };
  });
  const core = await testCore({ manager: socket.client });
  const admin = await claimed(core);
  return { core, admin, socket };
}

// Oldest first.
function entries(core: TestCore) {
  return core.activity
    .recent()
    .reverse()
    .filter((entry) => entry.source === "system")
    .map(({ action, outcome, reason, personId, clientId, subjectId }) => ({
      action,
      outcome,
      reason,
      personId,
      clientId,
      subjectId,
    }));
}

describe("updates from the UI", () => {
  it("show the version, the channel and the update's progress", async () => {
    const { core, admin } = await host({ journal: journal() });

    const response = await get(core, "/api/system/update", admin);

    expect(response.statusCode).toBe(200);
    // Images, containers and backups stay with the manager.
    expect(response.json()).toEqual({
      version: "1.2.3",
      channel: "dev",
      update: {
        id: "a1b2c3d4",
        version: "dev-5e6f7a8",
        from: "dev-1a2b3c4",
        startedAt: "2026-10-28T10:00:00.000Z",
        finishedAt: null,
        step: "check",
        outcome: null,
        error: null,
        log: journal().log,
      },
    });
  });

  it("say how an update ended, and why it rolled back", async () => {
    const { core, admin } = await host({
      journal: journal({
        phase: "done",
        outcome: "rolled-back",
        finishedAt: "2026-10-28T10:02:00.000Z",
        error: "sanctum-core stopped",
        core: { status: "rolled-back", image: "x", fromVersion: "dev-1a2b3c4" },
      }),
    });

    const { update } = (await get(core, "/api/system/update", admin)).json();

    expect(update).toMatchObject({
      step: "done",
      outcome: "rolled-back",
      error: "sanctum-core stopped",
      finishedAt: "2026-10-28T10:02:00.000Z",
    });
  });

  it("list the versions the host can update to", async () => {
    const { core, admin } = await host();

    const response = await get(core, "/api/system/update/versions", admin);

    expect(response.json()).toEqual({
      channel: "dev",
      versions: [
        { version: "dev-5e6f7a8", builtAt: "2026-10-28T09:00:00Z" },
        { version: "dev-1a2b3c4", builtAt: "2026-10-27T09:00:00Z" },
      ],
    });
  });

  it("start when someone asks, and go in the activity log", async () => {
    const { core, admin, socket } = await host();

    const response = await post(
      core,
      "/api/system/update/start",
      { version: "dev-5e6f7a8" },
      admin,
    );

    expect(response.statusCode).toBe(202);
    expect(response.json().update).toMatchObject({
      version: "dev-5e6f7a8",
      step: "check",
    });
    expect(socket.received.at(-1)).toEqual({
      method: "POST",
      url: "/api/update",
      body: { version: "dev-5e6f7a8" },
    });
    expect(entries(core)).toEqual([
      {
        action: "update.start",
        outcome: "ok",
        reason: null,
        personId: admin.person.id,
        clientId: admin.client.id,
        subjectId: "dev-5e6f7a8",
      },
    ]);
  });

  it("start a stable or edge host on its channel when no version is given", async () => {
    const { core, admin, socket } = await host();

    await post(core, "/api/system/update/start", {}, admin);

    expect(socket.received.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/update",
      body: {},
    });
  });

  it("refuse what the manager refuses, and log it", async () => {
    const busy = await host({
      start: { status: 409, body: { error: "An update is already running" } },
    });
    const wrong = await host({
      start: {
        status: 400,
        body: { error: "A dev host updates to a dev-<commit> build" },
      },
    });

    const second = await post(
      busy.core,
      "/api/system/update/start",
      { version: "dev-5e6f7a8" },
      busy.admin,
    );
    const invalid = await post(
      wrong.core,
      "/api/system/update/start",
      { version: "1.0.0" },
      wrong.admin,
    );

    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "busy" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "invalid_version" });
    expect(entries(busy.core)).toMatchObject([
      { action: "update.start", outcome: "refused", reason: "busy" },
    ]);
    expect(entries(wrong.core)).toMatchObject([
      { outcome: "refused", reason: "invalid_version", subjectId: "1.0.0" },
    ]);
  });

  it("answer 503 while the manager is away, as it is while it updates itself", async () => {
    const { core, admin } = await host({
      versions: {
        status: 502,
        body: { error: "The host's registry did not answer" },
      },
    });
    const away = await testCore();
    const awayAdmin = await claimed(away);

    const versions = await get(core, "/api/system/update/versions", admin);
    const start = await post(away, "/api/system/update/start", {}, awayAdmin);

    expect(versions.statusCode).toBe(503);
    expect(versions.json()).toEqual({ error: "manager_unavailable" });
    expect(start.statusCode).toBe(503);
    expect(start.json()).toEqual({ error: "manager_unavailable" });
  });

  it("answer 503 to an older manager, as the new core meets it before the manager is replaced", async () => {
    // An older manager answers without the channel and lists no versions.
    const socket = await managerSocket((request: SocketRequest) =>
      request.method === "GET" && request.url === "/api/update"
        ? { status: 200, body: { update: journal() } }
        : { status: 404, body: { error: "Not found" } },
    );
    const core = await testCore({ manager: socket.client });
    const admin = await claimed(core);

    const status = await get(core, "/api/system/update", admin);
    const versions = await get(core, "/api/system/update/versions", admin);

    expect(status.statusCode).toBe(503);
    expect(status.json()).toEqual({ error: "manager_unavailable" });
    expect(versions.statusCode).toBe(503);
    expect(versions.json()).toEqual({ error: "manager_unavailable" });
  });

  it("are for every client, shared ones too", async () => {
    const { core, socket } = await host({ journal: journal() });
    const shared = sharedClient(core);
    const member = personWithClient(core);

    for (const { token } of [shared, member]) {
      for (const url of ["/api/system/update", "/api/system/update/versions"]) {
        expect((await get(core, url, { token })).statusCode).toBe(200);
      }
    }
    const start = await post(
      core,
      "/api/system/update/start",
      { version: "dev-5e6f7a8" },
      { token: shared.token },
    );

    expect(start.statusCode).toBe(202);
    expect(socket.received.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/update",
    });
    expect(entries(core)).toEqual([
      {
        action: "update.start",
        outcome: "ok",
        reason: null,
        personId: null,
        clientId: shared.id,
        subjectId: "dev-5e6f7a8",
      },
    ]);
  });
});
