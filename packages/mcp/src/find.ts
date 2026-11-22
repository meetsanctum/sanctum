import { readHostStatus } from "@meetsanctum/auth-protocol";
import { isIPv4 } from "node:net";

import { PinMismatch } from "./pinned.js";

// Finding a home: discovery on the home network first, by the home's id,
// then the addresses it answered on before. An address is only a hint: a
// home is the one whose pin passes and whose status names its id.

/** Addresses announcing this home on the network, within `waitMs`. */
export async function discover(homeId: string, waitMs = 2_000) {
  const { Bonjour } = await import("bonjour-service");
  const bonjour = new Bonjour();
  const found = new Set<string>();
  return new Promise<string[]>((resolve) => {
    const browser = bonjour.find({ type: "sanctum", protocol: "tcp" });
    const done = () => {
      clearTimeout(timer);
      browser.stop();
      bonjour.destroy();
      resolve([...found]);
    };
    browser.on("up", (service) => {
      const txt = (service.txt ?? {}) as Record<string, unknown>;
      const address = service.addresses?.find((each) => isIPv4(each));
      if (txt.home !== homeId || !address || !service.port) return;
      found.add(`https://${address}:${service.port}`);
      // The first answer is enough; others still count if they come with it.
      setTimeout(done, 100);
    });
    const timer = setTimeout(done, waitMs);
  });
}

export type Found = { url: string };

/**
 * The first of `urls` that answers as this home through `fetchFor`. Pin
 * mismatches and other homes are passed over; none answering is an error
 * that says which.
 */
export async function findHome(
  homeId: string,
  urls: string[],
  fetchFor: (url: string) => typeof fetch,
): Promise<Found> {
  let mismatched = false;
  for (const url of [...new Set(urls)]) {
    try {
      const response = await fetchFor(url)(new URL("/api/auth/status", url), {
        signal: AbortSignal.timeout(5_000),
      });
      const status = readHostStatus(await response.json());
      if (status?.homeId === homeId) return { url: new URL(url).origin };
      mismatched = true;
    } catch (error) {
      if (error instanceof PinMismatch) mismatched = true;
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
