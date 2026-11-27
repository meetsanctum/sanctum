import type { ModelFetchers } from "../src/models/endpoints.js";
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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  createCore,
  type CoreManager,
  type TestReplacements,
} from "../src/core.js";
import type { CoreDatabase } from "../src/database.js";
import type { createModules } from "../src/modules.js";
import { updatePendingFile } from "../src/update-pending.js";
import type { SunDays } from "../src/workflows/jobs.js";
import { fakeManager, type TestManager } from "./manager-support.js";
import { firstStarts, runnerApps } from "./runner-apps.js";

type ModuleOptions = Parameters<typeof createModules>[1];

// A core on a fresh database, and a device that talks to it the way the
// apps do: OPAQUE on its side, with fast key stretching for tests.

export const hostId = "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73";
const fast = {
  "argon2id-custom": { iterations: 1, memory: 1024, parallelism: 1 },
} as const;

const open: (() => Promise<void>)[] = [];
// The data folders testCore made. They go once every core of the test has
// stopped, since a later core of the same test may start on one.
const folders: string[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of open.splice(0)) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const folder of folders.splice(0)) {
    try {
      await rm(folder, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "The test's cores could not be cleaned up",
    );
  }
});

async function dataFolder() {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-core-"));
  folders.push(folder);
  return folder;
}

export function deferredDelivery() {
  const pending = deferredResult<void>();
  return { ...pending, resolve: () => pending.resolve(undefined) };
}

export function deferredResult<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

// The fixture apps' packages (test/fixtures/apps), as a catalog folder.
export const fixtureApps = fileURLToPath(
  new URL("./fixtures/apps", import.meta.url),
);

// A core as a host starts it (core.ts), through the same steps, with what a
// test replaces: the manager as fakeManager() plays it, the apps the test
// defines, its own clock, timers it ticks by hand, no start in the activity
// log and no listening. On a fresh database unless a test gives another
// core's. It resolves once the core runs and its background work of starting
// has ended: the apps are installed and have had their first starts, and
// workflows have started, unless an update is on trial.
export async function testCore(
  options: {
    allowedOrigins?: string[];
    hostId?: string | null;
    limits?: Partial<Limits>;
    // Starts as a core does while its update is on trial: only the health
    // check answers, and the apps and workflows wait for a commit, which the
    // test makes by hand.
    onTrial?: boolean;
    // How soon an app's update asks for its turn again, and where its versions are.
    appUpdates?: ModuleOptions["appUpdates"];
    // Apps the test defines, each run apart through the runner in this process.
    apps?: readonly AppPackage[];
    // Apps the test runs itself, each listening in its own folder under
    // `appSockets`.
    apart?: readonly ApartPackage[];
    appSockets?: string;
    supervision?: ModuleOptions["supervision"];
    manager?: TestManager;
    appTimeoutMs?: number;
    confirmMs?: number;
    firmwareStaleMs?: number;
    probeWaitMs?: number;
    holdLimitMs?: number;
    holdSettleMs?: number;
    agentCommandLimits?: ModuleOptions["agentCommandLimits"];
    transcriber?: ModuleOptions["transcriber"];
    speechRetrainAfterMs?: number;
    // Starts the core on another core's data, as after a restart.
    dataDir?: string;
    // Certificates from a test's CA: the core serves their chain over HTTPS
    // and binds sign-ins to the CA's pin.
    certificates?: TestReplacements["certificates"];
    speakerPort?: number;
    // The home's time zone, UTC unless a test says, and its sun times.
    // null: the home's own, from Places.
    timeZone?: string | null;
    sun?: () => SunDays | null;
    // When the clock starts.
    startsAt?: string;
    // The internet as the core sees it; by default there is none.
    fetch?: typeof fetch;
    // How the core reaches AI models in the home and on the internet; by
    // default neither answers.
    modelFetchers?: ModelFetchers;
    // Whether the household allowed every optional permission the apps
    // ask for before the test, as each app's page would have asked; tests
    // of the core's own first answers say false.
    allowed?: boolean;
    // The kit the core serves apps' pages, none unless a test gives one.
    kitDir?: string;
    // Until it resolves the apps' packages are still being staged, as after
    // an update: the core serves meanwhile, and installs them once it does.
    staged?: Promise<void>;
  } = {},
) {
  const dataDir = options.dataDir ?? (await dataFolder());
  // On trial only when the test says, whatever the core before it on this
  // data was: the manager's marker of an update it hasn't committed.
  const marker = join(dataDir, updatePendingFile);
  if (options.onTrial) await writeFile(marker, "test-update");
  else await rm(marker, { force: true });
  const clock = {
    now: new Date(options.startsAt ?? "2026-10-26T12:00:00Z").getTime(),
  };
  const now = () => new Date(clock.now);
  const claims: boolean[] = [];
  const logs: string[] = [];
  const lifecycleLogs: string[] = [];
  const sockets =
    options.appSockets ?? (await mkdtemp(join(tmpdir(), "sanctum-run-")));
  const runner = runnerApps({
    dataDir,
    sockets,
    manager: options.manager ?? fakeManager().manager,
  });
  const apps = runner.add(options.apps ?? []);
  const installed = [...apps, ...(options.apart ?? [])];
  const core = createCore(
    {
      host: "127.0.0.1",
      port: 0,
      speakerPort: options.speakerPort,
      allowedOrigins: options.allowedOrigins ?? [],
      dataDir,
      plainHttp: !options.certificates,
      officialAppsDir: join(dataDir, "no-catalog"),
      appsApart: [],
      packagesDir: join(dataDir, "no-packages"),
      kitDir: options.kitDir ?? join(dataDir, "no-kit"),
      managerSocket: join(dataDir, "no-manager.sock"),
      newHomeApps: [],
      version: "1.2.3",
    },
    {
      log: (message) => logs.push(message),
      lifecycleLog: (message) => lifecycleLogs.push(message),
      testReplacements: {
        now,
        manager: linkTo(runner.manager, {
          hostId: () =>
            options.hostId === undefined
              ? hostId
              : (options.hostId ?? undefined),
          // What the core tells the manager of the claim, as it starts and
          // once it's claimed.
          reportClaimed: async (claimed) => void claims.push(claimed),
          stagedApps: async () => ({}),
          signCertificate: async () => {
            throw new Error("A test's manager signs no certificate");
          },
          close: () => undefined,
        }),
        certificates: options.certificates,
        async installApps({ db, modules, onTrial }) {
          if (options.allowed ?? true) {
            allowEveryPermission(
              db,
              installed.map(({ apart }) => apart.manifest),
              now(),
            );
          }
          await modules.apps.start(
            options.staged ? options.staged.then(() => installed) : installed,
            { onTrial },
          );
          // Each app the test defines has had its first start, as one in the
          // core's process has once the core starts, unless it waits for a
          // commit.
          if (!onTrial) await firstStarts(modules.apps, apps);
        },
        ticking: false,
        recordsStarts: false,
        listens: options.speakerPort !== undefined,
        moduleOptions: {
          ...(options.appUpdates ? { appUpdates: options.appUpdates } : {}),
          limits: { ...defaultLimits, ...options.limits },
          appTimeoutMs: options.appTimeoutMs,
          appSockets: sockets,
          supervision: options.supervision,
          confirmMs: options.confirmMs,
          firmwareStaleMs: options.firmwareStaleMs,
          probeWaitMs: options.probeWaitMs,
          holdLimitMs: options.holdLimitMs,
          // Tests wait for a stopped light only when they ask to.
          holdSettleMs: options.holdSettleMs ?? 0,
          agentCommandLimits: options.agentCommandLimits,
          transcriber: options.transcriber,
          speechRetrainAfterMs: options.speechRetrainAfterMs,
          timeZone:
            options.timeZone === null
              ? undefined
              : () => options.timeZone ?? "UTC",
          sun: options.sun,
          fetch: options.fetch ?? noInternet,
          modelFetchers: options.modelFetchers ?? {
            home: noInternet,
            internet: noInternet,
          },
        },
      },
    },
  );
  open.push(async () => {
    await core.stop();
    await runner.close();
    if (!options.appSockets) {
      await rm(sockets, { recursive: true, force: true });
    }
    // The bus says only what the core did out of order: published before
    // its followers were set or after it closed (event-bus.ts).
    const outOfOrder = logs.filter((line) => line.startsWith("events: "));
    if (outOfOrder.length > 0) {
      throw new Error(
        `The test's core published out of order:\n${outOfOrder.join("\n")}`,
      );
    }
  });
  await core.start();
  if (!options.staged) await core.lifecycle.backgroundWorkSettled();
  if (core.lifecycle.phase() !== "running") {
    throw new Error(
      `The test's core didn't start:\n${lifecycleLogs.join("\n")}`,
    );
  }
  const modules = core.modules!;
  return {
    ...modules,
    db: core.db!,
    homeId: core.homeId,
    dataDir,
    server: core.server!,
    logs,
    // The lifecycle's own lines, apart from the modules' in `logs`.
    lifecycleLogs,
    claims,
    now,
    // Moves the core's clock on.
    advance: (ms: number) => (clock.now += ms),
    // Stops the core as a signal does, through its steps of stopping.
    stop: () => core.stop(),
    // Installs and starts more apps the test defines, through the runner as
    // `apps` are.
    async startApps(packages: readonly AppPackage[]) {
      const added = runner.add(packages);
      await modules.apps.start(added);
      await firstStarts(modules.apps, added);
    },
  };
}

// The test's manager as the core reaches it, with what a host's link over the
// manager's socket adds. The rest is as it is when asked, since a test can
// change it after the core has started.
function linkTo(
  manager: TestManager,
  link: Pick<
    CoreManager,
    "hostId" | "reportClaimed" | "stagedApps" | "signCertificate" | "close"
  >,
) {
  return new Proxy(manager, {
    get: (target, key, receiver) =>
      Object.hasOwn(link, key)
        ? link[key as keyof typeof link]
        : Reflect.get(target, key, receiver),
  }) as CoreManager;
}

export type TestCore = Awaited<ReturnType<typeof testCore>>;

// The household's yes to each permission the apps ask for that has no
// answer yet, before the core first sees them ask; an answer it has stays.
function allowEveryPermission(
  db: CoreDatabase,
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
