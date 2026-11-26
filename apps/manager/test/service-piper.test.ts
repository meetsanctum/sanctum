import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sanctumNetworkName } from "../src/core-container.js";
import { createOperations } from "../src/operations.js";
import {
  piperData,
  piperImage,
  piperSpec,
  piperUrl,
} from "../src/services/piper.js";
import { findService } from "../src/services/registry.js";
import { createServer } from "../src/server.js";
import { createServices } from "../src/services/services.js";
import { createServicesStateStore } from "../src/services/state.js";
import type { UpdateService } from "../src/update/service.js";
import { FakeDocker } from "./fake-docker.js";
import { hostDev } from "./host-dev.js";

// Piper, which the core wants for itself to turn its words into speech: no
// app asks for it, and the core reaches it on the `sanctum` network.

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function home(saved?: object) {
  const docker = new FakeDocker();
  docker.load(piperImage, { title: "wyoming-piper", version: "2.5.4" });
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-piper-"));
  if (saved) {
    await writeFile(join(dataDir, "services.json"), JSON.stringify(saved));
  }
  const dev = await hostDev();
  const onChange = vi.fn();
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
  return { docker, dataDir, services, onChange, server };
}

describe("Piper", () => {
  it("is a service for the core alone, with its voices in a volume", () => {
    const definition = findService("piper")!;
    expect(definition).toMatchObject({
      forApps: false,
      forCore: true,
      url: piperUrl,
      largeImage: true,
      dataNeedsNoCopy: true,
      dataVolumes: [piperData],
    });
    expect(piperUrl).toBe("tcp://sanctum-piper:10200");
    expect(piperSpec()).toEqual({
      image: "rhasspy/wyoming-piper:2.5.4",
      cmd: ["--voice", "en_US-norman-medium"],
      volumes: [{ name: "sanctum-piper-data", target: "/data" }],
      memoryMb: 512,
    });
  });

  it("runs while the core wants it, and stops with its voices kept", async () => {
    const { docker, dataDir, services } = await home();

    const wanted = await services.wantForCore("piper");
    expect(wanted.service).toMatchObject({
      name: "piper",
      core: true,
      state: "starting",
    });
    // Asking again changes nothing.
    await services.wantForCore("piper");
    const saved = JSON.parse(
      await readFile(join(dataDir, "services.json"), "utf8"),
    );
    expect(saved.core).toEqual(["piper"]);

    await services.reconcile();
    const container = docker.container("sanctum-piper")!;
    expect(container.running).toBe(true);
    expect(container.networks[sanctumNetworkName]).toBeDefined();
    // Nothing outside the host's Docker network reaches it.
    expect(container.options.HostConfig?.PortBindings).toBeUndefined();
    expect(container.options.Cmd).toEqual(["--voice", "en_US-norman-medium"]);
    expect(services.status("piper")).toMatchObject({
      core: true,
      state: "running",
      url: "tcp://sanctum-piper:10200",
    });

    await services.releaseForCore("piper");
    await services.reconcile();
    expect(docker.container("sanctum-piper")).toBeUndefined();
    expect(docker.volumes.has("sanctum-piper-data")).toBe(true);
    expect(services.status("piper")).toEqual({
      name: "piper",
      apps: [],
      state: "off",
    });
    const after = JSON.parse(
      await readFile(join(dataDir, "services.json"), "utf8"),
    );
    expect(after.core).toBeUndefined();
  });

  it("wants nothing for the core in a home saved before it could", async () => {
    const { services } = await home({ apps: {}, mqttAccounts: {} });

    expect([...services.wanted()]).toEqual([]);
  });

  it("is no app's to ask for, and the core asks for no other service", async () => {
    const { server } = await home();

    const byApp = await server.inject({
      method: "PUT",
      url: "/api/services/piper/apps/sanctum.example",
    });
    expect(byApp.statusCode).toBe(404);
    const other = await server.inject({
      method: "PUT",
      url: "/api/services/zigbee2mqtt/core",
    });
    expect(other.statusCode).toBe(404);
    const unknown = await server.inject({
      method: "DELETE",
      url: "/api/services/nothing/core",
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("is wanted and given up over the manager's socket", async () => {
    const { server, services, onChange } = await home();

    const wanted = await server.inject({
      method: "PUT",
      url: "/api/services/piper/core",
    });
    expect(wanted.statusCode).toBe(200);
    expect(wanted.json()).toEqual({
      service: { name: "piper", apps: [], core: true, state: "starting" },
    });
    expect(onChange).toHaveBeenCalled();
    expect(services.wanted().has("piper")).toBe(true);

    const released = await server.inject({
      method: "DELETE",
      url: "/api/services/piper/core",
    });
    expect(released.statusCode).toBe(204);
    expect(services.wanted().has("piper")).toBe(false);
  });
});
