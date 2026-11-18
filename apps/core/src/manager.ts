import { request } from "node:http";
import { z } from "zod";

import {
  appContainer,
  appUpdatesHeld,
  appUsage,
  capabilities,
  discoveryAnswer,
  heldServices,
  hostBody,
  hostHistory,
  hostStatus,
  keptCopy,
  lanVersion,
  managerAudit,
  noCapabilities,
  serviceGrant,
  signedCertificate,
  spaceFreed,
  spacePlan,
  stagedApps,
  startedBody,
  startedUpdate,
  updateStatus,
  versionList,
  type LanVersion,
  zigbeeSticks,
} from "./manager-answers.js";

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

/**
 * What an app's network may reach: its found devices' addresses, on its
 * ports, as the core's run and its count for the app name it.
 */
export type LanPolicy = {
  core: string;
  count: number;
  addresses: string[];
  ports: number[];
};

const appContainerPath = (app: string) =>
  `/api/apps/${encodeURIComponent(app)}/container`;
const askForCapabilitiesEveryMs = 30_000;
const appUpdatePath = (app: string) =>
  `/api/apps/${encodeURIComponent(app)}/update`;

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
    // such thing, and starts it afresh. An app that reaches devices comes with
    // its first policy, whose rules the manager loads into its network before
    // its container starts, and answers which it loaded.
    async startAppContainer(
      app: string,
      spec: {
        folder: string;
        memoryMb: number;
        dataMb: number;
        keep?: boolean;
        lan?: LanPolicy;
      },
    ): Promise<{ kept: boolean; lan?: LanVersion }> {
      const body = await once("PUT", appContainerPath(app), spec, 120_000);
      try {
        const started = startedBody.parse(JSON.parse(body));
        return {
          kept: started.kept === true,
          ...(started.lan ? { lan: started.lan } : {}),
        };
      } catch {
        return { kept: false };
      }
    },

    // Replaces what an app's network may reach, in the holder the policy
    // names, and answers which policy it holds now. One that isn't newer for
    // that holder, or names a holder the app's container no longer has, is
    // refused.
    async applyLanPolicy(
      app: string,
      policy: LanPolicy & { manager: string; holder: string },
    ) {
      return parseBody(
        lanVersion,
        await once("PUT", `${appContainerPath(app)}/lan`, policy, 15_000),
      );
    },

    // Stops it, which takes up to 10 s for one that doesn't answer.
    async stopAppContainer(app: string) {
      await once("POST", `${appContainerPath(app)}/stop`, undefined, 30_000);
    },

    async removeAppContainer(app: string) {
      await once("DELETE", appContainerPath(app), undefined, 30_000);
    },

    // Deletes a removed app's image, its update copies and what Go back
    // kept. Refused while anything still has them.
    async deleteAppData(app: string) {
      await once(
        "DELETE",
        `/api/apps/${encodeURIComponent(app)}/data`,
        undefined,
        60_000,
      );
    },

    // Erases a service's own data, once no app needs it and it has stopped.
    async eraseServiceData(service: string) {
      await once(
        "DELETE",
        `/api/services/${encodeURIComponent(service)}/data`,
        undefined,
        60_000,
      );
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

    // The Zigbee sticks plugged in that the manager recognises, by the host's
    // path; a serial adapter it doesn't know isn't one.
    async zigbeeSticks() {
      const { candidates } = parseBody(
        zigbeeSticks,
        await once("GET", "/api/services/zigbee2mqtt/coordinator"),
      );
      return candidates
        .filter((candidate) => candidate.profileId !== null)
        .map(({ path, label }) => ({ path, label }));
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

    // What the manager found on the home's network after its answer
    // `after`, or everything for none, looking for `services`. It answers
    // within 30 s, so this waits longer than a call usually does.
    async discovery(after: string | null, services: readonly string[]) {
      const query = new URLSearchParams({
        ...(after ? { after } : {}),
        services: services.join(","),
      });
      return parseBody(
        discoveryAnswer,
        await once("GET", `/api/discovery?${query}`, undefined, 40_000),
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
