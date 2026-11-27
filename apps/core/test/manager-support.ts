import { sightingKey, type Sighting } from "@meetsanctum/app-sdk";
import { mkdtemp } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

import type { AppContainerManager } from "../src/app-host/supervisor.js";
import type { AppUpdateManager } from "../src/app-host/updates.js";
import type { ServiceManager } from "../src/app-host/services.js";
import type { SightingsManager } from "../src/discovery/sightings.js";
import { hostResources, type HostStatus } from "../src/manager-answers.js";
import {
  createManagerClient,
  ManagerRefusal,
  ManagerUnavailable,
  type ManagerClient,
  type LanPolicy,
} from "../src/manager.js";
import type { PowerManager } from "../src/system/power.js";
import type { SpaceManager } from "../src/system/space.js";
import type { StatusManager } from "../src/system/status.js";
import type { UpdateManager } from "../src/system/updates.js";

// The manager as tests play it: a fake that answers the core's calls and
// remembers them, and one listening on a Unix socket as the real one does.

// The home id a manager client reports; a test core makes its own.
export const homeId = "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) {
    await close();
  }
});

// The dev Pi as its manager reports it (2026-11-02): a Raspberry Pi 4 with
// 8 GB and a 15 GB card, on Wi-Fi, running Zigbee's bridge and broker.
export function piStatus(): HostStatus {
  return {
    channel: "dev",
    model: "Raspberry Pi 4 Model B",
    os: "Debian GNU/Linux 13 (trixie)",
    architecture: "aarch64",
    uptimeSeconds: 421_763,
    hostname: "sanctum-dev",
    memory: {
      total: 8_199_577_600,
      available: 7_542_419_456,
      swapTotal: 2_147_479_552,
      swapFree: 2_147_479_552,
      containers: [
        { role: "core", bytes: 171_470_848 },
        { role: "manager", bytes: 109_514_752 },
        { role: "service", service: "zigbee2mqtt", bytes: 138_272_768 },
        { role: "service", service: "mosquitto", bytes: 8_204_288 },
        { role: "registry", bytes: 45_862_912 },
      ],
    },
    storage: {
      total: 15_072_243_712,
      used: 7_654_955_776,
      free: 6_917_287_936,
      software: 1_207_000_000,
      devBuilds: 1_349_000_000,
      backups: 17_400_000,
      services: [
        { service: "mosquitto", apps: ["sanctum.zigbee"], bytes: 280_500 },
        { service: "zigbee2mqtt", apps: ["sanctum.zigbee"], bytes: 9_183 },
      ],
    },
    processor: { cores: 4, usage: 0.03, mhz: 1800, celsius: 57.5 },
    power: { low: false, lastLowAt: null },
    network: {
      interface: "wlan0",
      kind: "wifi",
      address: "192.168.7.222",
      signalDbm: -37,
      speedMbps: null,
    },
    clock: true,
    services: [
      { name: "mosquitto", apps: [], state: "running" },
      { name: "zigbee2mqtt", apps: ["sanctum.zigbee"], state: "running" },
    ],
  };
}

// What the core asks of the manager.
export type TestManager = ServiceManager &
  AppContainerManager &
  AppUpdateManager &
  UpdateManager &
  StatusManager &
  PowerManager &
  Pick<ManagerClient, "hostResources" | "serviceUrl"> &
  Partial<
    Pick<
      ManagerClient,
      "wantServiceForCore" | "releaseServiceForCore" | "serviceConnection"
    >
  > &
  SpaceManager & {
    discovery?: SightingsManager["discovery"];
    deleteAppData?: (app: string) => Promise<void>;
    eraseServiceData?: (service: string) => Promise<void>;
  };

// A manager that runs every service it is asked for, and remembers what it
// was asked. It has never updated the host, and cannot now. It restarts and
// shuts down when asked, and frees 1.3 GB of 11 dev builds and an old Zigbee.
export function fakeManager() {
  const calls: string[] = [];
  // What it keeps for each app, beyond what it's asked for from here on.
  const kept = new Map<string, string[]>();
  // What its journal of apps' updates holds.
  const updates = new Map<
    string,
    { id: string } & Partial<Parameters<AppUpdateManager["beginAppUpdate"]>[1]>
  >();
  // What each app's last update kept for Go back.
  const copies = new Map<
    string,
    { id: string; from: { version: string; folder: string }; at: string }
  >();
  // The home's network as it looks for devices on it: what a test puts there
  // is found by the services the core asks for, every answer whole.
  const network = {
    asked: [] as string[][],
    sightings: new Map<string, Sighting>(),
    seq: 0,
    waiting: new Set<() => void>(),
    put(sighting: Sighting) {
      network.sightings.set(sightingKey(sighting), sighting);
      network.changed();
    },
    take(sighting: { service: string; name: string }) {
      network.sightings.delete(sightingKey(sighting));
      network.changed();
    },
    changed() {
      network.seq += 1;
      for (const wake of [...network.waiting]) wake();
    },
  };
  // The rules it loads into the network of each app that reaches devices:
  // the holder it made for each app's container, and every policy it loaded,
  // each answered once `answering` lets it. A test says whether it can.
  const lan = {
    can: false,
    made: 0,
    holders: new Map<string, string>(),
    loaded: [] as { app: string; policy: LanPolicy; holder: string }[],
    // Every policy it was handed after a start, as it arrived.
    asked: [] as LanPolicy[],
    answering: Promise.resolve(),
    // What an app's rules let through now.
    of(app: string) {
      return [...lan.loaded].reverse().find((each) => each.app === app)?.policy;
    },
  };
  // What it was asked to delete, as it was asked.
  const deleted: string[] = [];
  const manager: TestManager = {
    async hostResources() {
      return hostResources.parse(await manager.hostStatus());
    },
    serviceUrl: async () => null,
    capabilities: () => ({
      appContainers: true,
      memoryLimits: true,
      discovery: true,
      lan: lan.can,
      portRanges: lan.can,
      deletesData: true,
      reserves: false,
    }),
    async discovery(after, services) {
      network.asked.push([...services]);
      if (after === `test:${network.seq}`) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            network.waiting.delete(wake);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(wake, 100);
          network.waiting.add(wake);
        });
      }
      return {
        after: `test:${network.seq}`,
        full: true,
        found: [...network.sightings.values()].filter((sighting) =>
          services.includes(sighting.service),
        ),
        lost: [],
      };
    },
    async startAppContainer(app, spec) {
      if (!spec.lan) return { kept: false };
      const holder = `holder-${++lan.made}`;
      lan.holders.set(app, holder);
      lan.loaded.push({ app, policy: spec.lan, holder });
      const { core, count } = spec.lan;
      return { kept: false, lan: { core, count, manager: "test", holder } };
    },
    async applyLanPolicy(app, { manager: _, holder, ...policy }) {
      lan.asked.push(policy);
      await lan.answering;
      if (lan.holders.get(app) !== holder) {
        throw new ManagerRefusal("That holder isn't the app's", 409);
      }
      lan.loaded.push({ app, policy, holder });
      const { core, count } = policy;
      return { core, count, manager: "test", holder };
    },
    async stopAppContainer() {},
    async removeAppContainer() {},
    async deleteAppData(app: string) {
      deleted.push(`data ${app}`);
    },
    async eraseServiceData(service: string) {
      deleted.push(`service ${service}`);
    },
    appContainer: async () => ({ state: "stopped" }),
    appUsage: async () => ({
      memoryBytes: null,
      processor: null,
      dataBytes: null,
    }),
    async needService(service, app) {
      calls.push(`PUT ${service} ${app}`);
      return {
        mqtt: {
          url: "mqtt://sanctum-mosquitto:1883",
          username: app,
          password: "broker-password",
          topics: ["zigbee2mqtt/#"],
        },
        baseTopic: "zigbee2mqtt",
      };
    },
    async releaseService(service, app) {
      calls.push(`DELETE ${service} ${app}`);
    },
    async servicesHeldBy(app) {
      return kept.get(app) ?? [];
    },
    async beginAppUpdate(app, request) {
      calls.push(`BEGIN ${app} ${request.from.version} ${request.to.version}`);
      if (
        request.restores &&
        updates.get(app)?.id !== request.id &&
        copies.get(app)?.id !== request.restores
      ) {
        throw new ManagerRefusal("No such copy to go back to", 404);
      }
      updates.set(app, request);
    },
    async commitAppUpdate(app, id) {
      calls.push(`COMMIT ${app}`);
      const update = updates.get(app);
      if (update?.id !== id) return;
      updates.delete(app);
      if (update.restores || update.moves) {
        copies.delete(app);
      } else if (update.from?.folder) {
        copies.set(app, {
          id,
          from: { version: update.from.version, folder: update.from.folder },
          at: "2026-11-02T10:00:00.000Z",
        });
      }
    },
    async keptAppCopy(app) {
      return copies.get(app) ?? null;
    },
    async undoAppUpdate(app, id) {
      calls.push(`UNDO ${app}`);
      if (updates.get(app)?.id === id) updates.delete(app);
    },
    async appUpdates() {
      return Object.fromEntries(updates);
    },
    async revokeService(service, app) {
      calls.push(`REVOKE ${service} ${app}`);
    },
    async updateStatus() {
      return { channel: "dev", update: null };
    },
    async updateVersions() {
      return { channel: "dev", versions: [] };
    },
    async startUpdate() {
      throw new ManagerUnavailable("The manager did not answer");
    },
    async hostStatus() {
      return piStatus();
    },
    async hostHistory() {
      return {
        points: [
          {
            at: "2026-11-02T18:10:00.000Z",
            usage: 0.62,
            celsius: 61.5,
            memoryUsed: 1_190_000_000,
          },
        ],
      };
    },
    async power(action) {
      calls.push(`POST ${action}`);
    },
    async spacePlan() {
      return {
        bytes: 1_300_000_000,
        images: [{ service: "zigbee2mqtt", version: "2.14.1" }],
        devBuilds: 11,
        keeps: {
          running: "dev-ed4f70b",
          before: "dev-b7df8ce",
          newest: "dev-1040943",
        },
      };
    },
    async freeSpace() {
      calls.push("POST space/free");
      return { freed: 1_300_000_000 };
    },
  };
  return { manager, calls, kept, updates, network, lan, deleted };
}

export type SocketRequest = { method: string; url: string; body: unknown };

// A manager listening on a Unix socket, answering each request with what
// `answer` returns, and a client of it that retries quickly.
export async function managerSocket(
  answer: (request: SocketRequest) => { status: number; body?: unknown },
) {
  const socketPath = join(
    await mkdtemp(join(tmpdir(), "sanctum-")),
    "manager.sock",
  );
  const received: SocketRequest[] = [];
  const server = createHttpServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      const asked = {
        method: request.method ?? "",
        url: request.url ?? "",
        body: text ? JSON.parse(text) : undefined,
      };
      received.push(asked);
      const { status, body } = answer(asked);
      response.statusCode = status;
      response.end(body === undefined ? undefined : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const logs: string[] = [];
  const client = createManagerClient({
    socketPath,
    homeId,
    log: (message) => logs.push(message),
    retry: { firstMs: 5, maxMs: 20 },
  });
  open.push(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { client, received, logs, socketPath };
}
