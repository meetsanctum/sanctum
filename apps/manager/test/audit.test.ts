import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAudit, serviceChange } from "../src/audit.js";
import { createOperations } from "../src/operations.js";
import { mosquittoImage } from "../src/services/mosquitto.js";
import { zigbee2mqttImage } from "../src/services/zigbee2mqtt.js";
import { createServer } from "../src/server.js";
import { createServices } from "../src/services/services.js";
import { createServicesStateStore } from "../src/services/state.js";
import type { UpdateJournal } from "../src/update/journal.js";
import type { UpdateService } from "../src/update/service.js";
import { FakeDocker } from "./fake-docker.js";
import { hostDev, zbt2 } from "./host-dev.js";

// The manager's audit: what it did on its own, numbered and kept in its data
// volume, which the core copies into the activity log.

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const dataDir = () => mkdtemp(join(tmpdir(), "sanctum-audit-"));

function journal(fields: Partial<UpdateJournal> = {}): UpdateJournal {
  const step = { status: "updated" as const, image: "core" };
  return {
    id: "u1",
    version: "0.4.2",
    startedAt: "2026-10-29T22:01:00.000Z",
    finishedAt: "2026-10-29T22:04:00.000Z",
    phase: "done",
    outcome: "rolled-back",
    error: "The core did not start",
    core: { ...step, fromVersion: "0.4.1" },
    manager: step,
    log: [],
    ...fields,
  };
}

describe("the audit", () => {
  it("numbers its entries, keeps them across a restart, and answers what came after", async () => {
    const dir = await dataDir();
    const audit = await createAudit(dir);
    await audit.record({ action: "service.start", outcome: "ok" });
    await audit.record({ action: "service.stop", outcome: "ok" });

    const again = await createAudit(dir);
    const all = again.after(0);
    expect(all.entries.map(({ n, action }) => ({ n, action }))).toEqual([
      { n: 1, action: "service.start" },
      { n: 2, action: "service.stop" },
    ]);
    expect(again.after(1).entries.map((entry) => entry.n)).toEqual([2]);
    expect(again.after(0).audit).toBe(audit.after(0).audit);
    await again.record({ action: "service.start", outcome: "ok" });
    expect(again.after(2).entries.map((entry) => entry.n)).toEqual([3]);
  });

  it("keeps its last 1,000 entries", async () => {
    const dir = await dataDir();
    const audit = await createAudit(dir);
    for (let index = 0; index < 1_005; index++) {
      void audit.record({ action: "service.restart", outcome: "ok" });
    }
    await audit.saved();
    const saved = JSON.parse(await readFile(join(dir, "audit.json"), "utf8"));
    expect(saved.entries).toHaveLength(1_000);
    expect(saved.entries[0].n).toBe(6);
  });

  it("records how an update ended, once", async () => {
    const audit = await createAudit(await dataDir());
    await audit.updateEnded(journal({ phase: "core", outcome: undefined }));
    await audit.updateEnded(journal());
    await audit.updateEnded(journal());

    expect(audit.after(0).entries).toEqual([
      expect.objectContaining({
        // When it ended, not when the manager first heard.
        at: "2026-10-29T22:04:00.000Z",
        action: "update.end",
        outcome: "failed",
        reason: "The core did not start",
        detail: expect.objectContaining({
          id: "u1",
          version: "0.4.2",
          from: "0.4.1",
          outcome: "rolled-back",
        }),
      }),
    ]);
  });
});

describe("a service's change", () => {
  const running = { state: "running" as const, restarts: 0 };

  it("is news when it starts, starts again, stops, or cannot start", () => {
    const changes = [
      serviceChange("zigbee2mqtt", { state: "off" }, running),
      serviceChange("zigbee2mqtt", running, { ...running, restarts: 1 }),
      serviceChange("zigbee2mqtt", running, {
        state: "failed",
        problem: "It is exited",
      }),
      serviceChange("zigbee2mqtt", { state: "failed" }, running),
      serviceChange("zigbee2mqtt", running, { state: "off" }),
      serviceChange(
        "zigbee2mqtt",
        { state: "off" },
        { state: "waiting", problem: "No Zigbee coordinator is plugged in" },
      ),
    ];
    expect(changes.map((change) => change?.action)).toEqual([
      "service.start",
      "service.restart",
      "service.fail",
      "service.restart",
      "service.stop",
      "service.wait",
    ]);
    expect(changes[5]).toMatchObject({
      outcome: "failed",
      detail: {
        service: "zigbee2mqtt",
        problem: "No Zigbee coordinator is plugged in",
      },
    });
  });

  it("is no news when nothing changed, or when a running one is first seen", () => {
    const waiting = { state: "waiting" as const, problem: "No coordinator" };
    expect(serviceChange("mosquitto", undefined, running)).toBeNull();
    expect(serviceChange("mosquitto", running, running)).toBeNull();
    expect(serviceChange("zigbee2mqtt", waiting, waiting)).toBeNull();
  });
});

describe("GET /api/audit", () => {
  it("answers what the manager did, the services it ran and the adapter it chose included", async () => {
    const docker = new FakeDocker();
    docker.publish(mosquittoImage, { title: "mosquitto", version: "2.1.2" });
    docker.publish(zigbee2mqttImage, {
      title: "zigbee2mqtt",
      version: "2.14.2",
    });
    const dir = await dataDir();
    const dev = await hostDev();
    const audit = await createAudit(dir);
    const services = createServices({
      operations: createOperations(),
      docker,
      store: await createServicesStateStore(dir),
      dataDir: dir,
      hostDevDir: dev.root,
      log: () => undefined,
      onObserved: (name, before, after) => {
        const entry = serviceChange(name, before, after);
        if (entry) void audit.record(entry);
      },
      onCoordinator: (path, adapter, by) =>
        void audit.record({
          action: "zigbee.adapter",
          outcome: "ok",
          detail: { path, adapter: adapter ?? null, by },
        }),
    });
    await services.start();
    await services.need("zigbee2mqtt", "sanctum.zigbee");
    await services.reconcile();
    await dev.plug(zbt2, "ttyACM0");
    await services.reconcile();
    const server = createServer(
      { version: "dev-1" },
      {
        host: {
          docker,
          services,
          updates: { status: async () => journal() } as UpdateService,
        },
        audit,
      },
    );
    servers.push(server);

    const response = await server.inject({ url: "/api/audit?after=0" });
    expect(response.statusCode).toBe(200);
    const actions = response
      .json()
      .entries.map((entry: { action: string; detail: { problem?: string } }) =>
        `${entry.action} ${entry.detail.problem ?? ""}`.trim(),
      );
    expect(actions).toEqual([
      "service.wait No Zigbee coordinator is plugged in",
      "zigbee.adapter",
      "service.start",
      "update.end",
    ]);
    const bad = await server.inject({ url: "/api/audit?after=soon" });
    expect(bad.statusCode).toBe(400);
  });

  it("answers what it kept while an update's status cannot be read", async () => {
    const audit = await createAudit(await dataDir());
    await audit.record({ action: "service.start", outcome: "ok" });
    const server = createServer(
      { version: "dev-1" },
      {
        host: {
          docker: new FakeDocker(),
          updates: {
            status: async () => {
              throw new Error("update.json is unreadable");
            },
          } as unknown as UpdateService,
        },
        audit,
      },
    );
    servers.push(server);

    const response = await server.inject({ url: "/api/audit?after=0" });
    expect(response.statusCode).toBe(200);
    expect(
      response.json().entries.map((entry: { action: string }) => entry.action),
    ).toEqual(["service.start"]);
  });
});
