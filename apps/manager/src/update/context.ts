import type { DockerClientLike } from "../docker.js";
import type { Fetch } from "../socket.js";
import type { HealthTiming } from "./health.js";
import type { JournalStore } from "./journal.js";

export type UpdateContext = {
  docker: DockerClientLike;
  journal: JournalStore;
  // The manager's data directory, holding the journal and backups.
  dataDir: string;
  coreDataDir: string;
  coreUrl: string;
  // The manager's own API, for the updater's health check.
  managerSocket: string;
  timing: HealthTiming;
  // Asks the core for its health over HTTPS, trusting only the host CA
  // (certificates/core-fetch.ts).
  coreFetch?: Fetch;
  // Replaces the requests to both health checks in tests.
  fetch?: Fetch;
  log: (message: string) => void;
};
