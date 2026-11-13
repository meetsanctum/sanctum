import { request } from "node:http";
import { z } from "zod";

// The core reaches the manager over a Unix socket that only the two of them
// mount. The manager may be starting, or replacing itself in an update, so
// calls wait until the socket answers.

type Log = (message: string) => void;

// One request to the manager. Resolves with the status code and body;
// rejects when the socket does not answer.
function call(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 5_000,
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request(
      {
        socketPath,
        method,
        path,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : {},
        timeout: timeoutMs,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: text }),
        );
        response.on("error", reject);
      },
    );
    outgoing.on("timeout", () =>
      outgoing.destroy(new Error("The manager did not answer in time")),
    );
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

function expectOk(status: number) {
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}`);
  }
}

// An answer that asking again will not change, such as a service the manager
// does not run for apps.
export class ManagerRefusal extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

// The manager did not answer, or could not do it now, for a call a person
// waits on: they ask again rather than the core.
export class ManagerUnavailable extends Error {}

// Like expectOk, but a refusal (4xx) is final; anything else is retried.
function expectGranted(response: { status: number; body: string }) {
  if (response.status >= 400 && response.status < 500) {
    const detail = reason(response.body);
    throw new ManagerRefusal(
      `HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  expectOk(response.status);
}

// The reason the manager gave with a refusal, if any.
function reason(body: string) {
  try {
    return z.object({ error: z.string() }).parse(JSON.parse(body)).error;
  } catch {
    return "";
  }
}

function parseBody<T extends z.ZodType>(schema: T, body: string): z.output<T> {
  try {
    return schema.parse(JSON.parse(body));
  } catch {
    throw new ManagerRefusal("The manager's answer was not understood");
  }
}

const hostBody = z.object({ id: z.string().min(1).max(64) });

// The core's certificate and the host CA's, as PEM.
const signedCertificate = z.object({
  certificate: z.string().min(1),
  ca: z.string().min(1),
});

const channel = z.enum(["stable", "edge", "dev"]);
export type Channel = z.infer<typeof channel>;

// The manager's update journal (apps/manager/src/update/journal.ts), the
// parts the core passes on: where the update is and how it ended. Container
// ids, images and backup paths stay with the manager.
const updateStep = z.object({
  status: z.string(),
  fromVersion: z.string().optional(),
});
const updateJournal = z.object({
  id: z.string(),
  version: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  phase: z.enum(["pulling", "core", "manager", "done"]),
  outcome: z.enum(["updated", "unchanged", "rolled-back", "failed"]).optional(),
  error: z.string().optional(),
  core: updateStep,
  manager: updateStep,
  log: z.array(z.object({ at: z.string(), message: z.string() })),
});
export type UpdateJournal = z.infer<typeof updateJournal>;

const updateStatus = z.object({
  channel,
  update: updateJournal.nullable(),
});
const startedUpdate = z.object({ update: updateJournal });
// The manager's audit (apps/manager/src/audit.ts): its id, and its entries
// after the number asked.
const managerAudit = z.object({
  audit: z.string().min(1).max(64),
  entries: z.array(
    z.object({
      n: z.number().int().positive(),
      at: z.string(),
      action: z.string().min(1).max(64),
      outcome: z.enum(["ok", "refused", "failed"]),
      reason: z.string().nullable().optional(),
      detail: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
  ),
});
const versionList = z.object({
  channel,
  versions: z.array(
    z.object({ version: z.string(), builtAt: z.string().optional() }),
  ),
});
export type VersionList = z.infer<typeof versionList>;

// The host's status (apps/manager/src/host/status.ts), for Settings →
// Status. Sizes and memory are in bytes.
const hostStatus = z.object({
  channel,
  model: z.string().nullable(),
  os: z.string().nullable(),
  architecture: z.string().nullable(),
  uptimeSeconds: z.number().nullable(),
  hostname: z.string().nullable(),
  // An older manager doesn't say.
  memoryLimits: z.boolean().nullable().optional(),
  memory: z
    .object({
      total: z.number(),
      available: z.number(),
      swapTotal: z.number(),
      swapFree: z.number(),
      containers: z.array(
        z.object({
          role: z.enum(["core", "app", "manager", "service", "registry"]),
          service: z.string().optional(),
          // Which apps a service is for. An older manager doesn't say.
          apps: z.array(z.string()).optional(),
          app: z.string().optional(),
          bytes: z.number(),
        }),
      ),
    })
    .nullable(),
  storage: z
    .object({
      total: z.number(),
      free: z.number(),
      software: z.number().nullable(),
      devBuilds: z.number().nullable(),
      backups: z.number().nullable(),
      services: z.array(
        z.object({
          service: z.string(),
          apps: z.array(z.string()),
          bytes: z.number(),
        }),
      ),
      // An older manager has none.
      images: z
        .array(
          z.object({
            app: z.string(),
            state: z.enum(["ok", "missing", "damaged"]),
            sizeMb: z.number(),
            bytes: z.number(),
          }),
        )
        .optional(),
    })
    .nullable(),
  processor: z.object({
    cores: z.number(),
    usage: z.number().nullable(),
    mhz: z.number().nullable(),
    celsius: z.number().nullable(),
  }),
  power: z
    .object({ low: z.boolean(), lastLowAt: z.string().nullable() })
    .nullable(),
  network: z
    .object({
      interface: z.string(),
      kind: z.enum(["wifi", "ethernet", "other"]),
      address: z.string().nullable(),
      signalDbm: z.number().nullable(),
      speedMbps: z.number().nullable(),
    })
    .nullable(),
  clock: z.boolean().nullable(),
  services: z.array(
    z.object({
      name: z.string(),
      apps: z.array(z.string()),
      state: z.enum(["off", "starting", "running", "waiting", "failed"]),
      problem: z.string().optional(),
    }),
  ),
});
export type HostStatus = z.infer<typeof hostStatus>;

// The host's last 24 hours (apps/manager/src/host/history.ts): each 5
// minutes' mean, oldest first.
const hostHistory = z.object({
  points: z.array(
    z.object({
      at: z.string(),
      usage: z.number().nullable(),
      celsius: z.number().nullable(),
      memoryUsed: z.number().nullable(),
    }),
  ),
});
export type HostHistory = z.infer<typeof hostHistory>;

// What Free up space would remove and keep (apps/manager/src/host/space.ts).
const spacePlan = z.object({
  bytes: z.number(),
  images: z.array(
    z.object({ service: z.string(), version: z.string().nullable() }),
  ),
  devBuilds: z.number(),
  keeps: z.object({
    running: z.string(),
    before: z.string().nullable(),
    newest: z.string().nullable(),
  }),
});
export type SpacePlan = z.infer<typeof spacePlan>;
const spaceFreed = z.object({ freed: z.number().nullable() });

// What an app gets for a service (apps/manager/src/services/services.ts):
// its own broker account and anything else the service hands out, such as
// Zigbee2MQTT's base topic.
const serviceGrant = z.object({
  connection: z.looseObject({
    mqtt: z
      .object({
        url: z.string(),
        username: z.string(),
        password: z.string(),
        topics: z.array(z.string()),
      })
      .optional(),
  }),
});

// How an app's container stands.
const appContainer = z.object({
  state: z.enum(["running", "stopped", "none"]),
  exitCode: z.number().optional(),
  outOfMemory: z.boolean().optional(),
});

const appUsage = z.object({
  memoryBytes: z.number().nullable(),
  processor: z.number().nullable(),
  dataBytes: z.number().nullable(),
});

// What a start did: whether it kept the one running.
const startedBody = z.object({ kept: z.boolean().optional() });

const appContainerPath = (app: string) =>
  `/api/apps/${encodeURIComponent(app)}/container`;

// What the manager can do. An update replaces the core before the manager, so a
// new core can find itself under an old manager, which knows no such question.
const capabilities = z.object({
  appContainers: z.boolean(),
  memoryLimits: z.boolean(),
});
export type ManagerCapabilities = z.infer<typeof capabilities>;
const noCapabilities: ManagerCapabilities = {
  appContainers: false,
  memoryLimits: false,
};
const askForCapabilitiesEveryMs = 30_000;

const appUpdatePath = (app: string) =>
  `/api/apps/${encodeURIComponent(app)}/update`;

const appUpdatesHeld = z.object({
  updates: z.record(z.string(), z.object({ id: z.string() })),
});

const keptCopy = z.object({
  kept: z
    .object({
      id: z.string(),
      from: z.object({ version: z.string(), folder: z.string() }),
      at: z.string(),
    })
    .nullable(),
});

const stagedApps = z.object({
  apps: z.record(
    z.string(),
    z.object({ version: z.string(), folder: z.string() }),
  ),
});

const heldServices = z.object({
  services: z.array(z.object({ name: z.string(), apps: z.array(z.string()) })),
});

function servicePath(service: string, app: string) {
  return `/api/services/${encodeURIComponent(service)}/apps/${encodeURIComponent(app)}`;
}

export function createManagerClient(options: {
  socketPath: string;
  // The home's id, which the manager announces with the claimed flag.
  homeId: string;
  log: Log;
  retry?: { firstMs: number; maxMs: number };
}) {
  const { socketPath, log } = options;
  const retry = options.retry ?? { firstMs: 1_000, maxMs: 15_000 };
  let closed = false;
  const wakes = new Set<() => void>();
  let claimed = false;
  // An unclaimed report the manager has not had yet. A claim that follows
  // it at once must not replace it: the manager makes a new CA when a
  // claimed host comes back unclaimed.
  let unclaimedPending = false;
  let reporting: Promise<void> | undefined;
  let hostId: string | undefined;
  let learning = false;
  let known = noCapabilities;

  function pause(ms: number) {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        wakes.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      // HTTPS startup waits for these calls before opening its server, so
      // this retry may be the only handle keeping the core alive.
      wakes.add(wake);
    });
  }

  // One call: a refusal (4xx) is a ManagerRefusal; no answer, or one the
  // manager could not give now (5xx), is ManagerUnavailable.
  async function once(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ) {
    let response: { status: number; body: string };
    try {
      response = await call(socketPath, method, path, body, timeoutMs);
    } catch {
      throw new ManagerUnavailable("The manager did not answer");
    }
    if (response.status >= 500) {
      throw new ManagerUnavailable(
        reason(response.body) || `HTTP ${response.status}`,
      );
    }
    expectGranted(response);
    return response.body;
  }

  // Runs `attempt` until it reports that it is done, backing off while the
  // socket does not answer, or the manager does not know the call yet.
  async function untilDone(attempt: () => Promise<boolean>) {
    let delay = retry.firstMs;
    let waiting = false;
    while (!closed) {
      try {
        const done = await attempt();
        if (waiting) {
          log("manager: reachable");
          waiting = false;
        }
        if (done) {
          return;
        }
        continue;
      } catch (error) {
        if (!waiting) {
          log(
            `manager: waiting for ${socketPath} (${error instanceof Error ? error.message : String(error)})`,
          );
          waiting = true;
        }
      }
      await pause(delay);
      delay = Math.min(delay * 2, retry.maxMs);
    }
  }

  // Asks until the manager answers, then resolves with the answer, or
  // rejects with a ManagerRefusal or when the client closes.
  async function ask<T>(attempt: () => Promise<T>): Promise<T> {
    let answer: { value: T } | { refusal: unknown } | undefined;
    await untilDone(async () => {
      try {
        answer = { value: await attempt() };
      } catch (error) {
        if (!(error instanceof ManagerRefusal)) {
          throw error;
        }
        answer = { refusal: error };
      }
      return true;
    });
    if (!answer) {
      throw new Error("The manager client was closed");
    }
    if ("refusal" in answer) {
      throw answer.refusal;
    }
    return answer.value;
  }

  return {
    // What the manager could do when last asked.
    capabilities: () => known,

    // Keeps asking, without holding up anything else, since the same update's
    // manager step can bring more at any time. An answer it can't give leaves
    // the last one; a manager too old to know the question can do none of it.
    followCapabilities(everyMs = askForCapabilitiesEveryMs) {
      void (async () => {
        while (!closed) {
          let answer = known;
          try {
            answer = parseBody(
              capabilities,
              await once("GET", "/api/capabilities"),
            );
          } catch (error) {
            if (error instanceof ManagerRefusal) answer = noCapabilities;
            else if (!(error instanceof ManagerUnavailable)) throw error;
          }
          if (answer.appContainers !== known.appContainers) {
            log(
              `manager: ${answer.appContainers ? "can run apps" : "can't run apps yet"}`,
            );
          }
          known = answer;
          if (!closed) await pause(everyMs);
        }
      })().catch((error: unknown) => {
        log(`manager: stopped asking what it can do (${String(error)})`);
      });
    },

    // Tells the manager the home's id and whether the host is claimed, for
    // its announcement on the network. The latest value wins, once the
    // socket answers, except that an unclaimed report always arrives first;
    // resolves once it has been reported, or the client closes.
    reportClaimed(value: boolean): Promise<void> {
      claimed = value;
      unclaimedPending ||= !value;
      reporting ??= untilDone(async () => {
        const value = unclaimedPending ? false : claimed;
        const { status } = await call(socketPath, "PUT", "/api/claimed", {
          claimed: value,
          homeId: options.homeId,
        });
        expectOk(status);
        if (!value) unclaimedPending = false;
        return claimed === value && !unclaimedPending;
      }).finally(() => (reporting = undefined));
      return reporting;
    },

    // Asks the manager, the host's CA, to sign the core's public key, until
    // it does: the core serves nothing without a certificate. Rejects only
    // when the client closes.
    async signCertificate(publicKey: string) {
      let signed: z.output<typeof signedCertificate> | undefined;
      await untilDone(async () => {
        const response = await call(socketPath, "POST", "/api/certificate", {
          publicKey,
        });
        expectOk(response.status);
        signed = parseBody(signedCertificate, response.body);
        return true;
      });
      if (!signed) {
        throw new Error("The manager client was closed");
      }
      return signed;
    },

    // Asks the manager for the host's id once the socket answers. The
    // manager keeps it, so restores and update rollbacks of the core leave
    // it alone; it never changes while the core runs.
    learnHostId() {
      if (learning || hostId) {
        return;
      }
      learning = true;
      void untilDone(async () => {
        const response = await call(socketPath, "GET", "/api/host");
        expectOk(response.status);
        hostId = hostBody.parse(JSON.parse(response.body)).id;
        return true;
      }).finally(() => (learning = false));
    },

    hostId: () => hostId,

    // Runs an app in its own container, as its running version and limits say,
    // making or attaching its data's image first, which can take a while. With
    // `keep`, one already running as the manager would make it goes on, as after
    // the core restarted, which the answer says. A manager before that knows no
    // such thing, and starts it afresh.
    async startAppContainer(
      app: string,
      spec: {
        folder: string;
        memoryMb: number;
        dataMb: number;
        keep?: boolean;
      },
    ) {
      const body = await once("PUT", appContainerPath(app), spec, 120_000);
      try {
        return { kept: startedBody.parse(JSON.parse(body)).kept === true };
      } catch {
        return { kept: false };
      }
    },

    // Stops it, which takes up to 10 s for one that doesn't answer.
    async stopAppContainer(app: string) {
      await once("POST", `${appContainerPath(app)}/stop`, undefined, 30_000);
    },

    async removeAppContainer(app: string) {
      await once("DELETE", appContainerPath(app), undefined, 30_000);
    },

    // An app's update (apps/manager/src/apps/updates.ts). Taking the slot, stopping
    // it and copying its database can take a while, as can putting that back.
    async beginAppUpdate(
      app: string,
      request: {
        id: string;
        // No folder on an app's first move, from a core that ran it in its own
        // process.
        from: { version: string; folder?: string };
        to: { version: string; folder: string };
        file: string;
        // Going back: the update whose kept copy goes in place.
        restores?: string;
        // An app's first move: its file in the core's apps folder, and its image's size.
        moves?: string;
        dataMb?: number;
      },
    ) {
      await once("POST", appUpdatePath(app), request, 360_000);
    },

    async commitAppUpdate(app: string, id: string) {
      await once(
        "POST",
        `${appUpdatePath(app)}/${encodeURIComponent(id)}/commit`,
        undefined,
        30_000,
      );
    },

    async undoAppUpdate(app: string, id: string) {
      await once(
        "POST",
        `${appUpdatePath(app)}/${encodeURIComponent(id)}/undo`,
        undefined,
        180_000,
      );
    },

    async appUpdates() {
      return parseBody(appUpdatesHeld, await once("GET", "/api/apps/updates"))
        .updates;
    },

    // The packages staged for this core's image, which can take a while on an update.
    // An old manager or one that can't run apps has none, and one that doesn't answer
    // is asked again until `withinMs` is up: apps wait for this, but the core doesn't.
    async stagedApps(withinMs = 180_000) {
      const deadline = Date.now() + withinMs;
      while (!closed) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        try {
          const answer = await once(
            "GET",
            "/api/apps/staged",
            undefined,
            remainingMs,
          );
          return parseBody(stagedApps, answer).apps;
        } catch (error) {
          // Nothing is gained by waiting out a pause that outlasts the time left.
          if (
            error instanceof ManagerRefusal ||
            Date.now() + retry.firstMs >= deadline
          ) {
            log(`manager: no staged apps (${String(error)})`);
            return {};
          }
          if (!closed) await pause(retry.firstMs);
        }
      }
      return {};
    },

    // What Go back would return to, while its copy and package are still there.
    async keptAppCopy(app: string) {
      return parseBody(
        keptCopy,
        await once("GET", `${appUpdatePath(app)}/kept`),
      ).kept;
    },

    // How its container stands, and how it stopped.
    async appContainer(app: string) {
      return parseBody(appContainer, await once("GET", appContainerPath(app)));
    },

    // What it holds and uses now. Docker takes a second over it.
    async appUsage(app: string) {
      const path = `/api/apps/${encodeURIComponent(app)}/usage`;
      return parseBody(appUsage, await once("GET", path, undefined, 10_000));
    },

    // An app needs a service: the manager runs it from now on and answers
    // with the app's connection details. Asking again changes nothing.
    async needService(service: string, app: string) {
      return ask(async () => {
        const response = await call(
          socketPath,
          "PUT",
          servicePath(service, app),
        );
        expectGranted(response);
        return parseBody(serviceGrant, response.body).connection;
      });
    },

    // The services the manager keeps for the app, whatever this core asked for.
    async servicesHeldBy(app: string) {
      return ask(async () => {
        const response = await call(socketPath, "GET", "/api/services");
        expectGranted(response);
        return parseBody(heldServices, response.body)
          .services.filter(({ apps }) => apps.includes(app))
          .map(({ name }) => name);
      });
    },

    // The app's permission for the service was switched off: one call,
    // which the manager answers once the app's broker account is out of the
    // broker, so a person sees it off only when it is. Rejects when the
    // manager does not confirm in time.
    async revokeService(service: string, app: string) {
      await once("DELETE", servicePath(service, app), undefined, 30_000);
    },

    // The app no longer needs the service. Once no app does, the manager
    // stops it; its data stays. The manager answers once its reconcile has
    // run, which may wait for a service's container to stop, so this waits
    // as long as revokeService does.
    async releaseService(service: string, app: string) {
      await ask(async () => {
        const response = await call(
          socketPath,
          "DELETE",
          servicePath(service, app),
          undefined,
          30_000,
        );
        expectGranted(response);
      });
    },

    // Updates, asked once each: whoever asked waits for the answer and asks
    // again.
    async updateStatus() {
      return parseBody(updateStatus, await once("GET", "/api/update"));
    },

    // A dev host's manager asks its registry about every build, which can
    // take a Pi a moment.
    async updateVersions() {
      return parseBody(
        versionList,
        await once("GET", "/api/update/versions", undefined, 15_000),
      );
    },

    // What the manager did after its audit entry `after`, asked once.
    async audit(after: number) {
      return parseBody(
        managerAudit,
        await once("GET", `/api/audit?after=${after}`),
      );
    },

    // The host's status, asked once. Counting what takes the space can take
    // a Pi a moment the first time.
    async hostStatus() {
      return parseBody(
        hostStatus,
        await once("GET", "/api/host/status", undefined, 15_000),
      );
    },

    // The host's last 24 hours, asked once.
    async hostHistory() {
      return parseBody(hostHistory, await once("GET", "/api/host/history"));
    },

    // Restarts or shuts the host down, a moment after the manager answers.
    async power(action: "restart" | "shutdown") {
      await once("POST", `/api/host/${action}`);
    },

    // What Free up space would do: a dev host's manager asks its registry
    // about every build.
    async spacePlan() {
      return parseBody(
        spacePlan,
        await once("GET", "/api/host/space", undefined, 30_000),
      );
    },

    // Frees it, which on a dev host stops the registry while it collects
    // its garbage.
    async freeSpace() {
      return parseBody(
        spaceFreed,
        await once("POST", "/api/host/space/free", undefined, 5 * 60_000),
      );
    },

    // Starts an update to `version`, or on a stable or edge host to its
    // channel; the manager carries it out in the background.
    async startUpdate(version?: string) {
      const body = await once(
        "POST",
        "/api/update",
        version === undefined ? {} : { version },
      );
      return parseBody(startedUpdate, body).update;
    },

    close() {
      closed = true;
      for (const wake of wakes) {
        wake();
      }
    },
  };
}

export type ManagerClient = ReturnType<typeof createManagerClient>;
