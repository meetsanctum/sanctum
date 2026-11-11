import { loadConfig } from "./config.js";
import { createDockerClient } from "./docker.js";
import { defaultHealthTiming } from "./update/health.js";
import { createJournalStore } from "./update/journal.js";
import { runUpdater } from "./update/manager-update.js";

// Entry point of the short-lived updater container that swaps the manager
// (update/manager-update.ts). It runs from the new manager image.

const config = loadConfig();

await runUpdater({
  docker: createDockerClient(),
  journal: createJournalStore(config.dataDir),
  dataDir: config.dataDir,
  coreDataDir: config.coreDataDir,
  coreUrl: config.coreUrl,
  managerSocket: config.socket,
  timing: defaultHealthTiming,
  log: (message) => console.log(message),
});
