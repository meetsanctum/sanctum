import type { AppFailure, StaticManifest } from "@meetsanctum/app-sdk";
import { vi, type Mock } from "vitest";

import type { InstalledApp } from "../src/app-host/installed.js";
import {
  createSupervisor,
  newSupervision,
  type AppContainerManager,
} from "../src/app-host/supervisor.js";

// What keeps an app apart running, with time in the test's hands. An app's real
// containers are in apps/manager's real-image test.

export const manifest = {
  id: "test.supervised",
  version: "1.0.0",
  runtime: { memory: 128, data: 256 },
} as unknown as StaticManifest;

export function setUp(manager: Partial<AppContainerManager> = {}) {
  const started: string[] = [];
  const stopped: string[] = [];
  const reconciled: Mock<(entry: InstalledApp) => void> = vi.fn();
  const settled: Mock<(entry: InstalledApp) => void> = vi.fn();
  const gone: Mock<(entry: InstalledApp) => void> = vi.fn();
  const updateFailed: Mock<
    (entry: InstalledApp, failure: AppFailure) => boolean
  > = vi.fn(() => false);
  const logs: string[] = [];
  const entry = {
    app: { id: manifest.id },
    manifest,
    apartIn: "1.0.0+test",
    link: { isReady: () => false, isConnected: () => false },
    supervision: newSupervision(new Date()),
  } as unknown as InstalledApp;
  const supervisor = createSupervisor({
    manager: {
      capabilities: () => ({
        appContainers: true,
        memoryLimits: true,
        discovery: false,
      }),
      startAppContainer: async (app) => {
        started.push(app);
        return { kept: false };
      },
      stopAppContainer: async (app) => void stopped.push(app),
      removeAppContainer: async () => undefined,
      appContainer: async () => ({ state: "running" }),
      appUsage: async () => ({
        memoryBytes: null,
        processor: null,
        dataBytes: null,
      }),
      ...manager,
    },
    reconcile: reconciled,
    gone,
    announce: () => undefined,
    settled,
    updateFailed,
    updateNotReady: () => false,
    log: (message) => logs.push(message),
    now: () => new Date(),
  });
  const phase = () => entry.supervision!.phase;
  // A failure with the connection there, as a start that failed is.
  const fail = () => supervisor.startFailed(entry);
  return {
    entry,
    supervisor,
    started,
    stopped,
    reconciled,
    gone,
    settled,
    updateFailed,
    phase,
    fail,
  };
}

// What the supervisor does next takes a promise's turn and then its pause.
export const passes = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};
