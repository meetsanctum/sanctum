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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

import type { ApartPackage } from "../src/app-host/loader.js";
import type { AppPackage } from "./runner-apps.js";
import { appGrants } from "../src/app-host/schema.js";
import { defaultLimits, type Limits } from "../src/auth/limits.js";
import { authClients, authTokens } from "../src/auth/schema.js";
import { hashToken, newClientToken } from "../src/auth/tokens.js";
import { openCoreDatabase } from "../src/database.js";
import { createModules } from "../src/modules.js";
import { loadHomeId } from "../src/places/places.js";
import { createServer, type CoreHttps } from "../src/server.js";
import type { SunDays } from "../src/workflows/jobs.js";
import { fakeManager, type TestManager } from "./manager-support.js";
import { firstStarts, runnerApps } from "./runner-apps.js";

// A core on a fresh database, and a device that talks to it the way the
// apps do: OPAQUE on its side, with fast key stretching for tests.

export const hostId = "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73";
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
    // Apps the test defines, each run apart through the runner in this process.
    apps?: readonly AppPackage[];
    // Apps the test runs itself, each listening in its own folder under
    // `appSockets`.
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
  const sockets =
    options.appSockets ?? (await mkdtemp(join(tmpdir(), "sanctum-run-")));
  const runner = runnerApps({
    dataDir,
    sockets,
    manager: options.manager ?? fakeManager().manager,
  });
  const apps = runner.add(options.apps ?? []);
  const modules = await createModules(database.db, {
    ...(options.appUpdates ? { appUpdates: options.appUpdates } : {}),
    dataDir,
    version: "1.2.3",
    manager: runner.manager,
    hostId: () =>
      options.hostId === undefined ? hostId : (options.hostId ?? undefined),
    homeId: coreHomeId,
    pin: () => options.pin ?? null,
    onClaimed: () => claims.push(true),
    log: (message) => logs.push(message),
    limits: { ...defaultLimits, ...options.limits },
    now,
    appTimeoutMs: options.appTimeoutMs,
    appSockets: sockets,
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
  // What the core starts as it starts (core.ts): discovery, and the deadlines
  // of firmware updates under way.
  modules.discovery?.start();
  modules.firmware.start();
  if (options.allowed ?? true) {
    allowEveryPermission(
      database.db,
      [...apps, ...(options.apart ?? [])].map(({ apart }) => apart.manifest),
      now(),
    );
  }
  if (options.onTrial) modules.workflows.hold();
  await modules.apps.start([...apps, ...(options.apart ?? [])], {
    onTrial: options.onTrial ?? false,
  });
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
    await runner.close();
    if (!options.appSockets) {
      await rm(sockets, { recursive: true, force: true });
    }
  });
  // Each app the test defines has had its first start, as one in the core's
  // process has once the core starts, unless it waits for a commit.
  if (!options.onTrial) await firstStarts(modules.apps, apps);
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
    // Installs and starts more apps the test defines, through the runner as
    // `apps` are.
    async startApps(packages: readonly AppPackage[]) {
      const added = runner.add(packages);
      await modules.apps.start(added);
      await firstStarts(modules.apps, added);
    },
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
