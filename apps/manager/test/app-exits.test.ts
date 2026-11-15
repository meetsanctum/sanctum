import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appContainerName,
  createAppContainers,
  nodeImage,
} from "../src/apps/containers.js";
import { createAppExits } from "../src/apps/exits.js";
import { FakeDocker } from "./fake-docker.js";

const app = "sanctum.weather";
const folder = "0.3.0+1a2b3c4d5e6f7a8b";
const name = appContainerName(app);
const spec = { app, folder, memoryMb: 128 };

const listening: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const stop of listening.splice(0)) stop();
});

// Docker's events reach the manager a moment after they happen.
const delivered = () => new Promise((done) => setTimeout(done, 5));

async function setup({ listen = true } = {}) {
  const docker = new FakeDocker();
  docker.load(nodeImage, { title: "node", version: "24" });
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-exits-"));
  const path = join(dataDir, "packages", app, folder);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), "{}");
  const exits = createAppExits({ docker, log: vi.fn(), listenAgainMs: 10 });
  listening.push(() => exits.stop());
  if (listen) exits.start();
  const apps = createAppContainers({
    docker,
    dataDir,
    log: vi.fn(),
    totalMemory: () => 8 * 1024 * 1024 * 1024,
    ownFolder: async () => undefined,
    images: { ensure: async () => "sanctum-app-data-sanctum.weather" },
    exits,
  });
  return { apps, docker, exits };
}

async function started() {
  const parts = await setup();
  await parts.apps.start(spec);
  await delivered();
  return parts;
}

describe("how an app's container stopped", () => {
  it("says the kernel killed it for its memory, though Docker's flag says not", async () => {
    const { apps, docker } = await started();

    docker.exit(name, { exitCode: 137, oomKilled: false });

    await expect(apps.status(app)).resolves.toMatchObject({
      state: "stopped",
      exitCode: 137,
      outOfMemory: true,
    });
  });

  it("waits for Docker to say it died, a moment after it stopped", async () => {
    const { apps, docker } = await started();
    docker.exit(name, { exitCode: 137 }, { died: false });

    const status = apps.status(app);
    setTimeout(() => docker.died(name), 50);

    await expect(status).resolves.toMatchObject({ outOfMemory: true });
  });

  it("says not, once Docker hasn't said it died in a moment", async () => {
    const { apps, docker } = await started();
    docker.exit(name, { exitCode: 137 }, { died: false });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const status = apps.status(app);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(status).resolves.toMatchObject({ outOfMemory: false });
  });

  it("takes Docker's flag when it has it, without waiting", async () => {
    const { apps, docker } = await started();

    docker.exit(name, { exitCode: 137, oomKilled: true }, { died: false });

    await expect(apps.status(app)).resolves.toMatchObject({
      outOfMemory: true,
    });
  });

  it("says one that exited by itself didn't run out", async () => {
    const { apps, docker } = await started();

    docker.exit(name, { exitCode: 1 });

    await expect(apps.status(app)).resolves.toMatchObject({
      exitCode: 1,
      outOfMemory: false,
    });
  });

  it("never says so of a stop the manager asked for, killed once it ran out of time", async () => {
    const { apps, docker } = await started();
    docker.ignoresStop = true;

    await expect(apps.stop(app)).resolves.toMatchObject({
      exitCode: 137,
      outOfMemory: false,
    });
    await expect(apps.status(app)).resolves.toMatchObject({
      outOfMemory: false,
    });
  });

  it("knows its own stops even had Docker dropped what it sent", async () => {
    const { apps, docker } = await started();
    docker.ignoresStop = true;
    docker.unreported.add("kill");

    await expect(apps.stop(app)).resolves.toMatchObject({
      exitCode: 137,
      outOfMemory: false,
    });
  });

  it("never says so of a stop someone else asked Docker for", async () => {
    const { apps, docker } = await started();
    docker.ignoresStop = true;

    await docker.getContainer(name).stop();

    await expect(apps.status(app)).resolves.toMatchObject({
      exitCode: 137,
      outOfMemory: false,
    });
  });

  it("leaves one it didn't see start to Docker's flag", async () => {
    const { apps, docker, exits } = await setup({ listen: false });
    await apps.start(spec);
    exits.start();
    await delivered();

    docker.exit(name, { exitCode: 137, oomKilled: false });

    await expect(apps.status(app)).resolves.toMatchObject({
      outOfMemory: false,
    });
  });

  it("forgets what it heard when Docker's events end, and listens again", async () => {
    const { apps, docker } = await started();

    docker.endEvents();
    await vi.waitFor(() => expect(docker.listened).toBe(2));
    docker.exit(name, { exitCode: 137 });

    // What came while it wasn't listening is unknown.
    await expect(apps.status(app)).resolves.toMatchObject({
      outOfMemory: false,
    });

    await apps.start(spec);
    await delivered();
    docker.exit(name, { exitCode: 137 });
    await expect(apps.status(app)).resolves.toMatchObject({
      outOfMemory: true,
    });
  });
});
