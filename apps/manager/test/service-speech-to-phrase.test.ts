import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

// Speech-to-Phrase, which the core wants for itself to hear smart speakers'
// words: no app asks for it, the core reaches it on the `sanctum` network,
// and teaching it takes a token the manager gives only the container and the
// core.

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function home(saved?: object) {
  const docker = new FakeDocker();
  docker.load(speechToPhraseImage, {
    title: "sanctum-speech-to-phrase",
    version: "2.2.0",
  });
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-stp-"));
  if (saved) {
    await writeFile(join(dataDir, "services.json"), JSON.stringify(saved));
  }
  const dev = await hostDev();
  const services = createServices({
    operations: createOperations(),
    docker,
    store: await createServicesStateStore(dataDir),
    dataDir,
    hostDevDir: dev.root,
    log: () => {},
    onChange: vi.fn(),
  });
  const server = createServer(
    { version: "dev-1" },
    { host: { docker, updates: {} as UpdateService, services } },
  );
  servers.push(server);
  return { docker, dataDir, services, server };
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
    expect(speechToPhraseUrl).toBe("tcp://sanctum-speech-to-phrase:10300");
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
    // Nothing outside the host's Docker network reaches it.
    expect(container.options.HostConfig?.PortBindings).toBeUndefined();
    expect(container.options.Env).toContain(`SANCTUM_TRAIN_TOKEN=${token}`);
    expect(container.options.HostConfig?.Binds).toEqual([
      "sanctum-speech-to-phrase-data:/data",
    ]);
    expect(services.status("speech-to-phrase")).toMatchObject({
      core: true,
      state: "running",
      url: "tcp://sanctum-speech-to-phrase:10300",
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
    // The token stays for its next start, with the grammar it taught.
    expect((await saved(dataDir)).tokens).toEqual(tokens);
  });

  it("keeps a token it made before", async () => {
    const { docker, services } = await home({
      apps: {},
      core: ["speech-to-phrase"],
      mqttAccounts: {},
      tokens: { "speech-to-phrase": "a".repeat(64) },
    });

    await services.wantForCore("speech-to-phrase");
    await services.reconcile();
    expect(docker.container("sanctum-speech-to-phrase")!.options.Env).toContain(
      `SANCTUM_TRAIN_TOKEN=${"a".repeat(64)}`,
    );
  });

  it("is no app's to ask for", async () => {
    const { server } = await home();

    const byApp = await server.inject({
      method: "PUT",
      url: "/api/services/speech-to-phrase/apps/sanctum.example",
    });
    expect(byApp.statusCode).toBe(404);
  });

  it("is wanted over the manager's socket, which answers its token once it runs", async () => {
    const { server, services } = await home();

    const wanted = await server.inject({
      method: "PUT",
      url: "/api/services/speech-to-phrase/core",
    });
    expect(wanted.statusCode).toBe(200);
    expect(wanted.json().service).not.toHaveProperty("token");

    await services.reconcile();
    const status = await server.inject({
      method: "GET",
      url: "/api/services/speech-to-phrase",
    });
    expect(status.json().service).toMatchObject({
      url: "tcp://sanctum-speech-to-phrase:10300",
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
