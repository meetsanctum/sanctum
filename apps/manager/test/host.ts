import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reconcileCore } from "../src/core-container.js";
import { createOperations } from "../src/operations.js";
import type { UpdateContext } from "../src/update/context.js";
import { createJournalStore } from "../src/update/journal.js";
import { managerContainerName } from "../src/update/manager-update.js";
import { createUpdateService } from "../src/update/service.js";
import { FakeDocker } from "./fake-docker.js";

export const registry = "localhost:5000";
export const image = (service: string, version: string) =>
  `${registry}/sanctum-${service}:${version}`;

// A dev host running core and manager dev-1: Compose created the manager, the
// manager created the core, and the core keeps a database in its volume.
export async function createHost() {
  const root = await mkdtemp(join(tmpdir(), "sanctum-manager-"));
  const dataDir = join(root, "manager");
  const coreDataDir = join(root, "core");
  await mkdir(coreDataDir, { recursive: true });
  await writeFile(join(coreDataDir, "core.db"), "dev-1 data");

  const docker = new FakeDocker();
  docker.coreDataDir = coreDataDir;
  docker.load(image("core", "dev-1"), {
    title: "sanctum-core",
    version: "dev-1",
  });
  docker.load(image("manager", "dev-1"), {
    title: "sanctum-manager",
    version: "dev-1",
  });
  await reconcileCore({ docker, image: image("core", "dev-1"), log: () => {} });
  docker.run({
    name: managerContainerName,
    Image: image("manager", "dev-1"),
    Env: ["SANCTUM_CHANNEL=dev"],
    Labels: {
      "com.docker.compose.project": "sanctum",
      "com.docker.compose.service": "manager",
    },
    HostConfig: {
      NetworkMode: "host",
      Binds: [
        "/var/run/docker.sock:/var/run/docker.sock",
        "sanctum-manager-data:/data",
        "sanctum-core-data:/core-data",
        "sanctum-manager-socket:/run/sanctum",
      ],
      RestartPolicy: { Name: "unless-stopped" },
    },
  });
  docker.events = [];

  const context: UpdateContext = {
    docker,
    journal: createJournalStore(dataDir),
    dataDir,
    coreDataDir,
    coreUrl: "http://127.0.0.1:4100",
    managerSocket: join(root, "manager.sock"),
    timing: { timeoutMs: 100, settleMs: 0, intervalMs: 5 },
    fetch: docker.fetch,
    log: () => {},
  };
  const committed: string[] = [];
  const updates = createUpdateService({
    operations: createOperations(),
    ...context,
    config: {
      channel: "dev",
      devRegistry: registry,
      imageOwner: "meetsanctum",
      version: "dev-1",
    },
    async onCoreCommitted(core) {
      committed.push(core);
    },
  });

  // Publishes a release; by default its manager is the same image as dev-1.
  function release(
    version: string,
    options: {
      core?: "healthy" | "unhealthy" | "crash";
      manager?: "healthy" | "unhealthy" | "crash" | "same";
    } = {},
  ) {
    docker.publish(image("core", version), {
      title: "sanctum-core",
      version,
      behaviour: options.core ?? "healthy",
    });
    if ((options.manager ?? "same") === "same") {
      docker.alias(image("manager", version), image("manager", "dev-1"));
    } else {
      docker.publish(image("manager", version), {
        title: "sanctum-manager",
        version,
        behaviour: options.manager as "healthy",
      });
    }
  }

  async function update(version: string) {
    await updates.start(version);
    await updates.wait();
    return (await context.journal.read())!;
  }

  return {
    committed,
    context,
    coreDataDir,
    dataDir,
    docker,
    release,
    update,
    updates,
  };
}
