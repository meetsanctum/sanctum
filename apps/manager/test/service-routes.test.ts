import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOperations } from "../src/operations.js";
import { mosquittoImage } from "../src/services/mosquitto.js";
import { createServer } from "../src/server.js";
import { createServices } from "../src/services/services.js";
import { createServicesStateStore } from "../src/services/state.js";
import type { UpdateService } from "../src/update/service.js";
import { FakeDocker } from "./fake-docker.js";
import { conbee, hostDev, zbt2 } from "./host-dev.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function manager() {
  const docker = new FakeDocker();
  docker.publish(mosquittoImage, { title: "mosquitto", version: "2.1.2" });
  const dev = await hostDev();
  const onChange = vi.fn();
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-manager-"));
  const services = createServices({
    operations: createOperations(),
    docker,
    store: await createServicesStateStore(dataDir),
    dataDir,
    hostDevDir: dev.root,
    log: () => {},
    onChange,
  });
  const server = createServer(
    { version: "dev-1" },
    { host: { docker, updates: {} as UpdateService, services } },
  );
  servers.push(server);
  return { dev, docker, services, onChange, server };
}

describe("the services API", () => {
  it("gives an app its connection details and starts the service", async () => {
    const { onChange, server } = await manager();

    const needed = await server.inject({
      method: "PUT",
      url: "/api/services/zigbee2mqtt/apps/sanctum.zigbee",
    });

    expect(needed.statusCode).toBe(200);
    expect(needed.json()).toEqual({
      service: {
        name: "zigbee2mqtt",
        apps: ["sanctum.zigbee"],
        state: "starting",
      },
      connection: {
        mqtt: {
          url: "mqtt://sanctum-mosquitto:1883",
          username: "sanctum.zigbee",
          password: expect.any(String),
          topics: ["zigbee2mqtt/#"],
        },
        baseTopic: "zigbee2mqtt",
      },
    });
    expect(onChange).toHaveBeenCalled();
    const list = await server.inject({ url: "/api/services" });
    expect(list.json().services).toEqual([
      { name: "mosquitto", apps: [], state: "starting" },
      { name: "zigbee2mqtt", apps: ["sanctum.zigbee"], state: "starting" },
    ]);
    const one = await server.inject({ url: "/api/services/zigbee2mqtt" });
    expect(one.json()).toMatchObject({ service: { name: "zigbee2mqtt" } });
  });

  it("lets an app give a service up", async () => {
    const { server, services, onChange } = await manager();
    await server.inject({
      method: "PUT",
      url: "/api/services/zigbee2mqtt/apps/sanctum.zigbee",
    });

    onChange.mockImplementation(() => services.reconcile());
    const released = await server.inject({
      method: "DELETE",
      url: "/api/services/zigbee2mqtt/apps/sanctum.zigbee",
    });

    expect(released.statusCode).toBe(204);
    const one = await server.inject({ url: "/api/services/zigbee2mqtt" });
    expect(one.json().service).toEqual({
      name: "zigbee2mqtt",
      apps: [],
      state: "off",
    });
  });

  it("answers a give-up once the reconcile that takes the app's broker account out has run", async () => {
    const { onChange, server, services } = await manager();
    await server.inject({
      method: "PUT",
      url: "/api/services/zigbee2mqtt/apps/sanctum.zigbee",
    });
    let reconciled!: () => void;
    onChange.mockImplementation(
      () => new Promise<void>((resolve) => (reconciled = resolve)),
    );

    let hasAnswered = false;
    const released = server
      .inject({
        method: "DELETE",
        url: "/api/services/zigbee2mqtt/apps/sanctum.zigbee",
      })
      .then((response) => {
        hasAnswered = true;
        return response;
      });
    // The give-up has asked for its reconcile, after the PUT's.
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    const answeredBeforeReconcile = hasAnswered;
    await services.reconcile();
    reconciled();

    expect(answeredBeforeReconcile).toBe(false);
    expect((await released).statusCode).toBe(204);
  });

  it.each([false, true])(
    "does not confirm a revocation while the old broker remains (another app: %s)",
    async (hasOtherApp) => {
      const { docker, services, onChange, server } = await manager();
      const url = "/api/services/zigbee2mqtt/apps/sanctum.zigbee";
      await server.inject({ method: "PUT", url });
      if (hasOtherApp) await services.need("zigbee2mqtt", "sanctum.other");
      await services.reconcile();
      const broker = docker.container("sanctum-mosquitto")!;
      const getContainer = docker.getContainer.bind(docker);
      const failure = vi
        .spyOn(docker, "getContainer")
        .mockImplementation((id) => {
          const container = getContainer(id);
          if (id !== broker.id && id !== broker.name) return container;
          return {
            ...container,
            stop: async () => {
              throw new Error("Docker unavailable");
            },
            remove: async () => {
              throw new Error("Docker unavailable");
            },
          };
        });
      onChange.mockImplementation(() => services.reconcile());

      const refused = await server.inject({ method: "DELETE", url });

      expect(broker.running).toBe(true);
      expect(refused.statusCode).toBeGreaterThanOrEqual(500);
      failure.mockRestore();
      const retried = await server.inject({ method: "DELETE", url });
      expect(retried.statusCode).toBe(204);
      expect(docker.container("sanctum-mosquitto")?.id).not.toBe(broker.id);
    },
  );

  it("refuses services apps cannot ask for, and ids that are not apps", async () => {
    const { server } = await manager();

    const broker = await server.inject({
      method: "PUT",
      url: "/api/services/mosquitto/apps/sanctum.zigbee",
    });
    const unknown = await server.inject({ url: "/api/services/postgres" });
    const notAnApp = await server.inject({
      method: "PUT",
      url: "/api/services/zigbee2mqtt/apps/zigbee",
    });

    expect(broker.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(notAnApp.statusCode).toBe(400);
  });

  it("accepts app ids up to the service's 128-character limit", async () => {
    const { server, services, onChange } = await manager();
    const app = `sanctum.${"a".repeat(120)}`;
    const url = `/api/services/zigbee2mqtt/apps/${app}`;

    const needed = await server.inject({ method: "PUT", url });
    expect(needed.statusCode).toBe(200);
    expect(needed.json().connection.mqtt.username).toBe(app);

    onChange.mockImplementation(() => services.reconcile());
    const released = await server.inject({ method: "DELETE", url });
    expect(released.statusCode).toBe(204);
  });

  it("lists the coordinators plugged in and takes a choice", async () => {
    const { dev, server } = await manager();
    await dev.plug(zbt2, "ttyACM0");
    await dev.plug(conbee, "ttyACM1");

    const listed = await server.inject({
      url: "/api/services/zigbee2mqtt/coordinator",
    });
    expect(listed.json()).toEqual({
      chosen: null,
      candidates: [
        expect.objectContaining({ path: conbee, adapter: "deconz" }),
        expect.objectContaining({ path: zbt2, recommended: true }),
      ],
    });

    const unplugged = await server.inject({
      method: "PUT",
      url: "/api/services/zigbee2mqtt/coordinator",
      payload: { path: "/dev/ttyUSB9" },
    });
    const invalid = await server.inject({
      method: "PUT",
      url: "/api/services/zigbee2mqtt/coordinator",
      payload: { path: zbt2, adapter: "telepathy" },
    });
    const chosen = await server.inject({
      method: "PUT",
      url: "/api/services/zigbee2mqtt/coordinator",
      payload: { path: zbt2 },
    });

    expect(unplugged.statusCode).toBe(400);
    expect(invalid.statusCode).toBe(400);
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json().chosen).toEqual({
      path: zbt2,
      adapter: "ember",
      profileId: "nabu-casa-zbt-2",
    });
  });

  it("answers 503 when the manager supervises no host", async () => {
    const server = createServer({ version: "dev" });
    servers.push(server);

    const response = await server.inject({ url: "/api/services" });
    const nested = await server.inject({
      method: "PUT",
      url: "/api/services/zigbee2mqtt/apps/sanctum.zigbee",
    });

    expect(response.statusCode).toBe(503);
    expect(nested.statusCode).toBe(503);
  });
});
