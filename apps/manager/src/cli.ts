import { coreFetch } from "./certificates/core-fetch.js";
import { loadConfig } from "./config.js";
import { socketFetch } from "./socket.js";
import type { UpdateJournal } from "./update/journal.js";

// A small client for the manager's API, through its socket, for the dev
// channel, Docker's health check and people at the host's shell. An update
// replaces the manager's container, so follow one from a container of its
// own that mounts the socket's volume:
//
//   docker run --rm -v sanctum-manager-socket:/run/sanctum <manager image> node dist/cli.js update dev-1a2b3c4
//   docker exec sanctum-manager node dist/cli.js status
//
// It waits through the manager swapping itself, when the API is briefly
// away, and exits non-zero unless the update went through.
//
// It prints the host CA's certificate, to check the core from a shell, and
// asks the core for its health as the update path does, over HTTPS trusting
// only the host CA:
//
//   docker exec sanctum-manager node dist/cli.js ca > host-ca.pem
//   curl --cacert host-ca.pem https://sanctum-dev.local:4100/api/health
//   docker exec sanctum-manager node dist/cli.js core-health
//
// It also turns services on and off and chooses the Zigbee coordinator by hand:
//
//   docker exec sanctum-manager node dist/cli.js services need zigbee2mqtt sanctum.zigbee
//   docker exec sanctum-manager node dist/cli.js coordinator choose /dev/serial/by-id/usb-...

const config = loadConfig();
const fetchManager = socketFetch(config.socket);
const base = "http://manager/api/update";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(method: "GET" | "POST", body?: unknown) {
  const response = await fetchManager(base, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5_000),
  });
  const payload = (await response.json()) as {
    update?: UpdateJournal | null;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload.update ?? null;
}

function print(journal: UpdateJournal, from: number) {
  for (const entry of journal.log.slice(from)) {
    console.log(`${entry.at.slice(11, 19)}  ${entry.message}`);
  }
  return journal.log.length;
}

async function follow(id: string) {
  let printed = 0;
  let unreachableSince: number | null = null;
  for (;;) {
    try {
      const journal = await request("GET");
      unreachableSince = null;
      if (journal?.id !== id) {
        throw new Error("Another update replaced this one");
      }
      printed = print(journal, printed);
      if (journal.phase === "done") {
        return journal.outcome === "updated" || journal.outcome === "unchanged";
      }
    } catch (error) {
      if (!(
        error instanceof TypeError || (error as Error).name === "TimeoutError"
      )) {
        throw error;
      }
      // The manager is restarting as part of the update.
      unreachableSince ??= Date.now();
      if (Date.now() - unreachableSince > 180_000) {
        throw new Error("The manager has not answered for three minutes");
      }
    }
    await sleep(1_000);
  }
}

// The host CA's certificate, from the manager.
async function caCertificate() {
  const response = await fetchManager("http://manager/api/certificate/ca", {
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.json()) as {
    certificate?: string;
    error?: string;
  };
  if (!response.ok || !body.certificate) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return body.certificate;
}

// One call to the services API; prints its answer.
async function callServices(method: string, path: string, body?: unknown) {
  const response = await fetchManager(`http://manager/api/${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  console.log(
    text ? JSON.stringify(JSON.parse(text), null, 2) : response.status,
  );
  return response.ok;
}

function services(args: string[]) {
  const [action, service, app] = args;
  if (action === undefined) {
    return callServices("GET", "services");
  }
  if ((action === "need" || action === "release") && service && app) {
    return callServices(
      action === "need" ? "PUT" : "DELETE",
      `services/${encodeURIComponent(service)}/apps/${encodeURIComponent(app)}`,
    );
  }
  return undefined;
}

function coordinator(args: string[]) {
  const [action, path, adapter] = args;
  const route = "services/zigbee2mqtt/coordinator";
  if (action === undefined) {
    return callServices("GET", route);
  }
  if (action === "choose" && path) {
    return callServices("PUT", route, { path, adapter });
  }
  return undefined;
}

async function main(
  command: string | undefined,
  version: string | undefined,
  args: string[],
) {
  if (command === "health") {
    const response = await fetchManager("http://manager/api/health", {
      signal: AbortSignal.timeout(5_000),
    });
    console.log(await response.text());
    return response.ok;
  }
  if (command === "ca") {
    process.stdout.write(await caCertificate());
    return true;
  }
  if (command === "core-health") {
    const ca = await caCertificate();
    const response = await coreFetch(() => ca)(`${config.coreUrl}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    console.log(await response.text());
    return response.ok;
  }
  if (command === "update") {
    const started = await request("POST", version ? { version } : {});
    if (!started) {
      throw new Error("The manager did not start an update");
    }
    return follow(started.id);
  }
  if (command === "status") {
    const journal = await request("GET");
    if (journal) {
      print(journal, 0);
      console.log(
        `${journal.phase}${journal.outcome ? `: ${journal.outcome}` : ""}`,
      );
    } else {
      console.log("No update has run yet");
    }
    return true;
  }
  const result =
    command === "services"
      ? services(args)
      : command === "coordinator"
        ? coordinator(args)
        : undefined;
  if (result) {
    return result;
  }
  console.error(
    [
      "Usage: cli.js update [version] | status | health | ca | core-health",
      "       cli.js services [need|release <service> <app>]",
      "       cli.js coordinator [choose <path> [adapter]]",
    ].join("\n"),
  );
  return false;
}

main(process.argv[2], process.argv[3], process.argv.slice(3)).then(
  (ok) => process.exit(ok ? 0 : 1),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
