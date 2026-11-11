import {
  keyStretching,
  passwordChangeBinding,
  signInBinding,
  verifySignInConfirmation,
  type ClaimFinish,
  type HostView,
  type SignedIn,
} from "@meetsanctum/auth-protocol";
import * as opaque from "@serenity-kit/opaque";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

import type { ApartPackage, AppPackage } from "../src/app-host/host.js";
import type { AppContainerManager } from "../src/app-host/supervisor.js";
import type { AppUpdateManager } from "../src/app-host/updates.js";
import { appGrants } from "../src/app-host/schema.js";
import type { ServiceManager } from "../src/app-host/services.js";
import { defaultLimits, type Limits } from "../src/auth/limits.js";
import { authClients, authTokens } from "../src/auth/schema.js";
import { hashToken, newClientToken } from "../src/auth/tokens.js";
import { openCoreDatabase } from "../src/database.js";
import {
  createManagerClient,
  ManagerRefusal,
  ManagerUnavailable,
  type HostStatus,
} from "../src/manager.js";
import { createModules } from "../src/modules.js";
import { loadHomeId } from "../src/places/places.js";
import { createServer, type CoreHttps } from "../src/server.js";
import type { PowerManager } from "../src/system/power.js";
import type { SpaceManager } from "../src/system/space.js";
import type { StatusManager } from "../src/system/status.js";
import type { UpdateManager } from "../src/system/updates.js";
import type { SunDays } from "../src/workflows/jobs.js";

// A core on a fresh database, and a device that talks to it the way the
// apps do: OPAQUE on its side, with fast key stretching for tests.

export const hostId = "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73";
// The home id a manager client reports; a test core makes its own.
export const homeId = "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55";
const fast = {
  "argon2id-custom": { iterations: 1, memory: 1024, parallelism: 1 },
} as const;

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) {
    await close();
  }
});

// The fixture apps' packages (test/fixtures/apps), as a catalog folder.
export const fixtureApps = fileURLToPath(
  new URL("./fixtures/apps", import.meta.url),
);

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
      address: "192.168.3.222",
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
  SpaceManager;

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
  const manager: TestManager = {
    capabilities: () => ({ appContainers: true, memoryLimits: true }),
    async startAppContainer() {},
    async stopAppContainer() {},
    async removeAppContainer() {},
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
  return { manager, calls, kept, updates };
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
  return { client, received, logs };
}

export async function testCore(
  options: {
    allowedOrigins?: string[];
    hostId?: string | null;
    limits?: Partial<Limits>;
    updatePending?: () => boolean;
    // Starts as a core does while its update is on trial, until the test commits.
    onTrial?: boolean;
    // How soon an app's update asks for its turn again, and where its versions are.
    appUpdates?: Parameters<typeof createModules>[1]["appUpdates"];
    apps?: readonly AppPackage[];
    // Apps that run apart, each listening in its own folder under `appSockets`.
    apart?: readonly ApartPackage[];
    appSockets?: string;
    supervision?: Parameters<typeof createModules>[1]["supervision"];
    manager?: TestManager;
    appTimeoutMs?: number;
    confirmMs?: number;
    firmwareStaleMs?: number;
    probeWaitMs?: number;
    holdLimitMs?: number;
    holdSettleMs?: number;
    // Starts the core on another core's data, as after a restart.
    dataDir?: string;
    // The host CA's pin the core binds sign-ins to, and the chain it serves.
    pin?: string;
    https?: CoreHttps;
    // The home's time zone, UTC unless a test says, and its sun times.
    // null: the home's own, from Places.
    timeZone?: string | null;
    sun?: () => SunDays | null;
    // When the clock starts.
    startsAt?: string;
    // The internet as the core sees it; by default there is none.
    fetch?: typeof fetch;
    // Whether the household allowed every optional permission the apps
    // ask for before the test, as each app's page would have asked; tests
    // of the core's own first answers say false.
    allowed?: boolean;
  } = {},
) {
  const dataDir =
    options.dataDir ?? (await mkdtemp(join(tmpdir(), "sanctum-core-")));
  const database = openCoreDatabase(dataDir);
  const clock = {
    now: new Date(options.startsAt ?? "2026-10-26T12:00:00Z").getTime(),
  };
  const now = () => new Date(clock.now);
  const claims: boolean[] = [];
  const logs: string[] = [];
  const coreHomeId = loadHomeId(database.db, now);
  const modules = await createModules(database.db, {
    ...(options.appUpdates ? { appUpdates: options.appUpdates } : {}),
    dataDir,
    version: "1.2.3",
    manager: options.manager ?? fakeManager().manager,
    hostId: () =>
      options.hostId === undefined ? hostId : (options.hostId ?? undefined),
    homeId: coreHomeId,
    pin: () => options.pin ?? null,
    onClaimed: () => claims.push(true),
    log: (message) => logs.push(message),
    limits: { ...defaultLimits, ...options.limits },
    now,
    appTimeoutMs: options.appTimeoutMs,
    appSockets: options.appSockets,
    supervision: options.supervision,
    confirmMs: options.confirmMs,
    firmwareStaleMs: options.firmwareStaleMs,
    probeWaitMs: options.probeWaitMs,
    holdLimitMs: options.holdLimitMs,
    // Tests wait for a stopped light only when they ask to.
    holdSettleMs: options.holdSettleMs ?? 0,
    timeZone:
      options.timeZone === null ? undefined : () => options.timeZone ?? "UTC",
    sun: options.sun,
    fetch: options.fetch ?? noInternet,
  });
  if (options.allowed ?? true) {
    allowEveryPermission(
      database.db,
      [
        ...(options.apps ?? []).map(({ app }) => app),
        ...(options.apart ?? []).map(({ apart }) => apart.manifest),
      ],
      now(),
    );
  }
  if (options.onTrial) modules.workflows.hold();
  await modules.apps.start(
    [...(options.apps ?? []), ...(options.apart ?? [])],
    {
      onTrial: options.onTrial ?? false,
    },
  );
  // Tests move the clock and tick by hand.
  if (!options.onTrial) modules.workflows.start({ ticking: false });
  modules.history.start({ ticking: false });
  const server = createServer(
    { allowedOrigins: options.allowedOrigins ?? [], version: "1.2.3" },
    { ...modules, updatePending: options.updatePending, https: options.https },
  );
  open.push(async () => {
    await server.close();
    await modules.close();
    database.close();
  });
  return {
    ...modules,
    db: database.db,
    homeId: coreHomeId,
    dataDir,
    server,
    logs,
    claims,
    now,
    // Moves the core's clock on.
    advance: (ms: number) => (clock.now += ms),
  };
}

export type TestCore = Awaited<ReturnType<typeof testCore>>;

// The household's yes to each permission the apps ask for that has no
// answer yet, before the core first sees them ask; an answer it has stays.
function allowEveryPermission(
  db: ReturnType<typeof openCoreDatabase>["db"],
  apps: readonly { id: string; permissions: readonly { id: string }[] }[],
  updatedAt: Date,
) {
  const rows = apps.flatMap((app) =>
    app.permissions.map((request) => ({
      appId: app.id,
      permission: request.id,
      granted: true,
      updatedAt,
    })),
  );
  if (rows.length > 0) {
    db.insert(appGrants).values(rows).onConflictDoNothing().run();
  }
}

// A core under test never reaches the internet unless a test says how.
async function noInternet(input: string | URL | Request): Promise<Response> {
  throw new Error(`No internet in tests (${String(input)})`);
}

type Call = {
  token?: string;
  remoteAddress?: string;
  headers?: Record<string, string>;
};

export async function post(
  core: TestCore,
  url: string,
  payload: unknown,
  call: Call = {},
) {
  return core.server.inject({
    method: "POST",
    url,
    payload: payload as object,
    remoteAddress: call.remoteAddress,
    headers: {
      ...(call.token ? { authorization: `Bearer ${call.token}` } : {}),
      ...call.headers,
    },
  });
}

export async function get(core: TestCore, url: string, call: Call = {}) {
  return core.server.inject({
    method: "GET",
    url,
    remoteAddress: call.remoteAddress,
    headers: {
      ...(call.token ? { authorization: `Bearer ${call.token}` } : {}),
      ...call.headers,
    },
  });
}

// A shared client, as pairing creates one.
export function sharedClient(core: TestCore) {
  const id = randomUUID();
  const token = newClientToken();
  const at = new Date();
  core.db
    .insert(authClients)
    .values({
      id,
      name: "Kitchen tablet",
      kind: "shared",
      platform: "android",
      createdAt: at,
    })
    .run();
  core.db
    .insert(authTokens)
    .values({
      id: randomUUID(),
      clientId: id,
      kind: "client",
      tokenHash: hashToken(token),
      createdAt: at,
    })
    .run();
  return { id, token };
}

const device = { name: "Maya's MacBook", platform: "macos" } as const;

export const maya = {
  username: "maya",
  password: "correct horse battery",
  person: { name: "Maya", colour: "#c5cdac" },
};

// Registers a password the way a device does: its first call answers the
// registration request, the second stores the record.
export function registration(password: string) {
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password });
  return {
    registrationRequest,
    finish: (registrationResponse: string) =>
      opaque.client.finishRegistration({
        clientRegistrationState,
        registrationResponse,
        password,
        keyStretching: fast,
      }).registrationRecord,
  };
}

export async function claim(
  core: TestCore,
  options: {
    username?: string;
    password?: string;
    person?: ClaimFinish["person"];
    remoteAddress?: string;
  } = {},
) {
  const password = options.password ?? maya.password;
  const started = registration(password);
  const start = await post(
    core,
    "/api/auth/claim/start",
    {
      username: options.username ?? maya.username,
      registrationRequest: started.registrationRequest,
    },
    options,
  );
  if (start.statusCode !== 200) {
    return start;
  }
  const { registrationId, registrationResponse } = start.json();
  return post(
    core,
    "/api/auth/claim/finish",
    {
      registrationId,
      registrationRecord: started.finish(registrationResponse),
      keyStretching: keyStretching.version,
      person: options.person ?? maya.person,
      client: device,
    },
    options,
  );
}

// Claims the host as Maya and returns her sign-in.
export async function claimed(core: TestCore): Promise<SignedIn> {
  const response = await claim(core);
  if (response.statusCode !== 200) {
    throw new Error(`claim failed: ${response.body}`);
  }
  return response.json();
}

export async function signIn(
  core: TestCore,
  options: {
    username?: string;
    password?: string;
    // The host the device believes it is talking to.
    sees?: HostView;
    remoteAddress?: string;
  } = {},
) {
  const password = options.password ?? maya.password;
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
    password,
  });
  const start = await post(
    core,
    "/api/auth/sign-in/start",
    { username: options.username ?? maya.username, startLoginRequest },
    options,
  );
  if (start.statusCode !== 200) {
    return { outcome: "refused" as const, response: start };
  }
  const { signInId, loginResponse } = start.json();
  const login = opaque.client.finishLogin({
    clientLoginState,
    loginResponse,
    password,
    keyStretching: fast,
  });
  if (!login) {
    // A wrong password, or a host without the household's records: the
    // device stops here and sends nothing more.
    return { outcome: "failed-on-device" as const, signInId };
  }
  const sees = options.sees ?? { hostId, homeId: core.homeId, pin: null };
  const finish = await post(
    core,
    "/api/auth/sign-in/finish",
    {
      signInId,
      finishLoginRequest: login.finishLoginRequest,
      binding: await signInBinding(login.sessionKey, sees),
      client: device,
    },
    options,
  );
  if (finish.statusCode !== 200) {
    return { outcome: "refused" as const, response: finish };
  }
  const body: SignedIn = finish.json();
  const confirmed = await verifySignInConfirmation(
    login.sessionKey,
    sees,
    body.token,
    body.confirmation!,
  );
  return { outcome: confirmed ? "signed-in" : "unconfirmed", body } as const;
}

export async function setLogin(
  core: TestCore,
  token: string,
  input: { personId: string; username: string; password: string },
) {
  const started = registration(input.password);
  const start = await post(
    core,
    "/api/auth/logins/set/start",
    {
      personId: input.personId,
      username: input.username,
      registrationRequest: started.registrationRequest,
    },
    { token },
  );
  if (start.statusCode !== 200) {
    return start;
  }
  const { registrationId, registrationResponse } = start.json();
  return post(
    core,
    "/api/auth/logins/set/finish",
    {
      registrationId,
      registrationRecord: started.finish(registrationResponse),
      keyStretching: keyStretching.version,
    },
    { token },
  );
}

export async function changePassword(
  core: TestCore,
  token: string,
  input: { current: string; next: string; sees?: HostView },
) {
  const login = opaque.client.startLogin({ password: input.current });
  const started = registration(input.next);
  const start = await post(
    core,
    "/api/auth/password/start",
    {
      startLoginRequest: login.startLoginRequest,
      registrationRequest: started.registrationRequest,
    },
    { token },
  );
  if (start.statusCode !== 200) {
    return start;
  }
  const { changeId, loginResponse, registrationResponse } = start.json();
  const proof = opaque.client.finishLogin({
    clientLoginState: login.clientLoginState,
    loginResponse,
    password: input.current,
    keyStretching: fast,
  });
  if (!proof) {
    return "failed-on-device" as const;
  }
  const registrationRecord = started.finish(registrationResponse);
  const sees = input.sees ?? { hostId, homeId: core.homeId, pin: null };
  return post(
    core,
    "/api/auth/password/finish",
    {
      changeId,
      finishLoginRequest: proof.finishLoginRequest,
      binding: await passwordChangeBinding(
        proof.sessionKey,
        sees,
        registrationRecord,
      ),
      registrationRecord,
      keyStretching: keyStretching.version,
    },
    { token },
  );
}
