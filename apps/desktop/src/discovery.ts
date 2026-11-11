import { readHostStatus } from "@meetsanctum/auth-protocol";
import { Bonjour, type Service } from "bonjour-service";
import { isIPv4 } from "node:net";

import type { FoundHost } from "./shell.js";

// Browses the home network for hosts announcing `_sanctum._tcp`. Discovery
// is only a hint: a paired app talks only to its host id, and checks the
// host's certificate before sending anything (trust.ts).

const serviceType = "sanctum";
// A host's id, or a home's.
const anId = /^[0-9A-Za-z-]{8,64}$/;
const idOrNull = (value: unknown) =>
  typeof value === "string" && anId.test(value) ? value : null;

// The host a DNS-SD answer describes, or none when it is not one. The app
// connects to an address from the answer rather than the `.local` name,
// which Chromium can take seconds to resolve: it checks the host CA's pin,
// never names.
export function foundHost(
  service: Pick<Service, "name" | "port" | "txt" | "addresses" | "referer">,
): FoundHost | undefined {
  const txt = (service.txt ?? {}) as Record<string, unknown>;
  const id = idOrNull(txt.id);
  const address =
    service.addresses?.find((candidate) => isIPv4(candidate)) ??
    (service.referer?.family === "IPv4" ? service.referer.address : undefined);
  if (!id || !address || !service.port) {
    return undefined;
  }
  return {
    id,
    // The home the host serves, from a manager and core that report one.
    homeId: idOrNull(txt.home),
    name: service.name,
    claimed: String(txt.claimed) === "1",
    url: `https://${address}:${service.port}`,
  };
}

// One entry per host id, sorted by name.
export function hostList(services: Parameters<typeof foundHost>[0][]) {
  const hosts = new Map<string, FoundHost>();
  for (const service of services) {
    const host = foundHost(service);
    if (host) {
      hosts.set(host.id, host);
    }
  }
  return [...hosts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// In development only, a host given by its URL (SANCTUM_DEV_HOST_URL), for
// networks where discovery cannot reach it. People never type an address, so
// a packaged app ignores it. Like an announcement, its answer is only a hint,
// so `fetchStatus` need not check the certificate: the page checks the host
// before it sends anything.
export function watchDevHost(
  url: string,
  onHost: (host: FoundHost | undefined) => void,
  fetchStatus: typeof fetch = fetch,
) {
  const origin = new URL(url).origin;
  const check = async () => {
    try {
      const response = await fetchStatus(new URL("/api/auth/status", origin), {
        redirect: "error",
        // A hint asks nothing of the host and sends nothing of this app.
        credentials: "omit",
        signal: AbortSignal.timeout(5_000),
      });
      const status = readHostStatus(await response.json());
      onHost(
        status && anId.test(status.hostId)
          ? {
              id: status.hostId,
              homeId: idOrNull(status.homeId),
              name: new URL(origin).hostname,
              claimed: status.claimed,
              url: origin,
            }
          : undefined,
      );
    } catch {
      onHost(undefined);
    }
  };
  void check();
  const timer = setInterval(() => void check(), 10_000);
  return () => clearInterval(timer);
}

export function watchHosts(onHosts: (hosts: FoundHost[]) => void) {
  const bonjour = new Bonjour();
  const browser = bonjour.find({ type: serviceType, protocol: "tcp" });
  const publish = () => onHosts(hostList(browser.services));
  browser.on("up", publish);
  browser.on("down", publish);
  browser.on("txt-update", publish);
  browser.on("srv-update", publish);
  // Asks again now and then, so a host that moved, flipped its claimed flag
  // or left shows up.
  const timer = setInterval(() => {
    browser.expire();
    browser.update();
    publish();
  }, 10_000);
  return () => {
    clearInterval(timer);
    browser.stop();
    bonjour.destroy();
  };
}
