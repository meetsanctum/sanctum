import { readHostStatus } from "@meetsanctum/auth-protocol";
import { isIPv4 } from "node:net";

import { PinMismatch } from "./pinned.js";

// Finding a home: discovery on the home network first, by the home's id,
// then the addresses it answered on before. An address is only a hint: a
// home is the one whose pin passes and whose status names its id.

/** Addresses announcing this home on the network, within `waitMs`. */
export async function discover(homeId: string, waitMs = 2_000) {
  const { Bonjour } = await import("bonjour-service");
  const found = new Set<string>();
  return new Promise<string[]>((resolve) => {
    let finished = false;
    let settle: NodeJS.Timeout | undefined;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(settle);
      browser.stop();
      bonjour.destroy();
      resolve([...found]);
    };
    const bonjour = new Bonjour({}, () => queueMicrotask(done));
    const browser = bonjour.find({ type: "sanctum", protocol: "tcp" });
    const heard = (service: (typeof browser.services)[number]) => {
      const txt = (service.txt ?? {}) as Record<string, unknown>;
      const address =
        service.addresses?.find((each) => isIPv4(each)) ??
        (service.referer?.family === "IPv4"
          ? service.referer.address
          : undefined);
      if (txt.home !== homeId || !address || !service.port) return;
      found.add(`https://${address}:${service.port}`);
      // The first answer is enough; others still count if they come with it.
      settle ??= setTimeout(done, 100);
    };
    browser.on("up", heard);
    browser.on("txt-update", heard);
    const timer = setTimeout(done, waitMs);
  });
}

/**
 * The first address that passes the pin and reports this home's id.
 * Address sources are tried in order, so discovery can wait until needed.
 */
export async function findHome(
  homeId: string,
  fetchHome: typeof fetch,
  ...sources: (string[] | (() => Promise<string[]>))[]
): Promise<string> {
  let mismatched = false;
  const tried = new Set<string>();
  for (const source of sources) {
    const urls =
      typeof source === "function" ? await source().catch(() => []) : source;
    for (const url of urls) {
      if (tried.has(url)) continue;
      tried.add(url);
      try {
        const response = await fetchHome(new URL("/api/auth/status", url), {
          signal: AbortSignal.timeout(5_000),
        });
        if (
          response.ok &&
          readHostStatus(await response.json())?.homeId === homeId
        ) {
          return new URL(url).origin;
        }
        if (!response.ok) await response.body?.cancel();
        mismatched = true;
      } catch (error) {
        if (error instanceof PinMismatch) mismatched = true;
      }
    }
  }
  throw new HomeNotFound(mismatched);
}

export class HomeNotFound extends Error {
  constructor(readonly mismatched: boolean) {
    super(
      mismatched
        ? "Found a computer on the network that isn't this home, and not the home itself"
        : "Couldn't reach the home",
    );
  }
}
