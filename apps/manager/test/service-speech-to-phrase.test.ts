import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCapacity, type HeldApp } from "../src/apps/capacity.js";
import { sanctumNetworkName } from "../src/core-container.js";
import { createOperations } from "../src/operations.js";
import { findService } from "../src/services/registry.js";
import { createServices } from "../src/services/services.js";
import {
  speechToPhraseData,
  speechToPhraseImage,
  speechToPhraseUrl,
} from "../src/services/speech-to-phrase.js";
import { createServicesStateStore } from "../src/services/state.js";
import { createServer } from "../src/server.js";
import type { UpdateService } from "../src/update/service.js";
import { FakeDocker } from "./fake-docker.js";
import { hostDev } from "./host-dev.js";

const name = "speech-to-phrase";
const containerName = "sanctum-speech-to-phrase";
const url = "tcp://sanctum-speech-to-phrase:10300";
const totalMemory = () => 4096 * 1024 * 1024;

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function home({
  saved,
  imageIsLocal = true,
  held = [],
}: {
  saved?: object;
  imageIsLocal?: boolean;
  held?: HeldApp[];
} = {}) {
  const docker = new FakeDocker();
  if (imageIsLocal) {
    docker.load(speechToPhraseImage, {
      title: containerName,
      version: "2.2.0",
    });
  }
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-stp-"));
  if (saved) {
    await writeFile(join(dataDir, "services.json"), JSON.stringify(saved));
  }
  const dev = await hostDev();
  const changed = vi.fn();
  const services = createServices({
    operations: createOperations(),
    docker,
    store: await createServicesStateStore(dataDir),
    dataDir,
    hostDevDir: dev.root,
    totalMemory,
    admitCoreService: (name, save) =>
      capacity.admitService(name, async () => held, save),
    log: () => {},
    onChange: changed,
  });
  const capacity = createCapacity({
    dataDir,
    totalMemory,
    services: services.wanted,
    heldServices: services.held,
  });
  const server = createServer(
    { version: "dev-1" },
    { host: { docker, updates: {} as UpdateService, services } },
  );
  servers.push(server);
  return { capacity, changed, docker, dataDir, services, server };
}

const saved = async (dataDir: string) =>
  JSON.parse(await readFile(join(dataDir, "services.json"), "utf8"));

describe("Speech-to-Phrase", () => {
  it("is a service for the core alone, with its models in a volume", () => {
    expect(findService("speech-to-phrase")).toMatchObject({
      forApps: false,
      forCore: true,
      token: true,
      url: speechToPhraseUrl,
      largeImage: true,
      dataNeedsNoCopy: true,
      dataVolumes: [speechToPhraseData],
    });
    expect(speechToPhraseUrl).toBe(url);
  });

  it("runs while the core wants it, with a token only it and the core get", async () => {
    const { docker, dataDir, services } = await home();

    await services.wantForCore("speech-to-phrase");
    const { tokens } = await saved(dataDir);
    const token = tokens["speech-to-phrase"] as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // Asking again keeps the token it made.
    await services.wantForCore("speech-to-phrase");
    expect((await saved(dataDir)).tokens).toEqual(tokens);

    await services.reconcile();
    const container = docker.container("sanctum-speech-to-phrase")!;
    expect(container.running).toBe(true);
    expect(container.networks[sanctumNetworkName]).toBeDefined();
    expect(container.options.HostConfig?.PortBindings).toBeUndefined();
    // The image's own command, which listens on every address at its port.
    expect(container.options.Cmd).toBeUndefined();
    expect(String(container.options.Healthcheck?.Test)).toContain(
      "nc -w 1 localhost 10300",
    );
    expect(container.options.Env).toContain(`SANCTUM_TRAIN_TOKEN=${token}`);
    expect(container.options.HostConfig?.Binds).toEqual([
      "sanctum-speech-to-phrase-data:/data",
    ]);
    expect(await services.endpoint(name)).toMatchObject({
      core: true,
      state: "running",
      url,
      token,
    });

    await services.releaseForCore("speech-to-phrase");
    await services.reconcile();
    expect(docker.container("sanctum-speech-to-phrase")).toBeUndefined();
    expect(docker.volumes.has("sanctum-speech-to-phrase-data")).toBe(true);
    // Off, it gives neither its url nor its token.
    expect(services.status("speech-to-phrase")).toEqual({
      name: "speech-to-phrase",
      apps: [],
      state: "off",
    });
    // The token stays for the next start, alongside any saved grammar.
    expect((await saved(dataDir)).tokens).toEqual(tokens);
  });

  it("starts from the saved request and keeps its token", async () => {
    const token = "a".repeat(64);
    const { docker, services } = await home({
      saved: {
        apps: {},
        core: [name],
        mqttAccounts: {},
        tokens: { [name]: token },
      },
    });

    await services.start();
    await services.reconcile();
    expect(docker.container(containerName)?.running).toBe(true);
    expect(docker.container(containerName)?.options.Env).toContain(
      `SANCTUM_TRAIN_TOKEN=${token}`,
    );
    expect(await services.endpoint(name)).toMatchObject({
      state: "running",
      token,
    });
  });

  it("pulls the published image when it is missing locally", async () => {
    const { changed, docker, services } = await home({ imageIsLocal: false });
    const ref = "ghcr.io/meetsanctum/sanctum-speech-to-phrase:2.2.0";
    const image = docker.publish(ref, {
      title: containerName,
      version: "2.2.0",
    });
    await services.wantForCore(name);
    changed.mockClear();

    await services.reconcile();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(docker.events).toContain(`pull ${ref}`);
    await services.reconcile();
    expect(docker.container(containerName)).toMatchObject({
      imageId: image,
      running: true,
    });
  });

  it("refuses a new request when the apps leave too little memory", async () => {
    const { services, server, docker } = await home({
      held: [{ app: "sanctum.example", memoryMb: 900, isRunning: true }],
    });
    const answer = await server.inject({
      method: "PUT",
      url: `/api/services/${name}/core`,
    });

    expect(answer.statusCode).toBe(409);
    expect(answer.json().error).toMatch(/needs 2200 MB.*2172 MB are left/);
    expect(services.wanted().has(name)).toBe(false);
    await services.reconcile();
    expect(docker.container(containerName)).toBeUndefined();
  });

  it("sets aside 2,200 MB of app capacity as soon as the core asks", async () => {
    const { capacity, services } = await home();
    const before = await capacity.freeMb([]);

    await services.wantForCore(name);

    expect(await capacity.freeMb([])).toBe(before - 2200);
  });

  it("is no app's to ask for", async () => {
    const { server } = await home();

    const byApp = await server.inject({
      method: "PUT",
      url: "/api/services/speech-to-phrase/apps/sanctum.example",
    });
    expect(byApp.statusCode).toBe(404);
  });

  it("returns the endpoint and token only from the individual lookup when healthy", async () => {
    const { docker, server, services } = await home();
    docker.onStart = (container) => {
      if (container === containerName)
        docker.container(container)!.health = "starting";
    };

    const wanted = await server.inject({
      method: "PUT",
      url: "/api/services/speech-to-phrase/core",
    });
    expect(wanted.statusCode).toBe(200);
    expect(wanted.json().service).not.toHaveProperty("token");

    await services.reconcile();
    const starting = await server.inject(`/api/services/${name}`);
    expect(starting.json().service).toMatchObject({ state: "starting" });
    expect(starting.json().service).not.toHaveProperty("url");
    expect(starting.json().service).not.toHaveProperty("token");

    docker.container(containerName)!.health = "healthy";
    await services.reconcile();
    const status = await server.inject(`/api/services/${name}`);
    expect(status.json().service).toMatchObject({
      state: "running",
      url,
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const list = await server.inject("/api/services");
    const listed = list
      .json()
      .services.find((service: { name: string }) => service.name === name);
    expect(listed).toMatchObject({ state: "running", url });
    expect(listed).not.toHaveProperty("token");

    // Docker can restart the service between two reconciles.
    docker.container(containerName)!.health = "starting";
    const restarted = await server.inject(`/api/services/${name}`);
    expect(restarted.json().service).toMatchObject({ state: "starting" });
    expect(restarted.json().service).not.toHaveProperty("url");
    expect(restarted.json().service).not.toHaveProperty("token");
  });
});
