import {
  netPermission,
  type NetRequest,
  type NetResponse,
} from "@meetsanctum/app-sdk";
import { isIP } from "node:net";
import { z } from "zod";

import { isPublicAddress } from "./public-internet.js";

// ctx.net.fetch(): apps have no fetch of their own, so this is their only
// way to the internet. It reaches only the hosts an app holds net:<host>
// for, over HTTPS, on the public internet only (public-internet.ts), follows
// no redirect, and waits at most 10 s for at most 1 MB. A request under way
// is aborted once its permission is switched off or the app stops, and an
// answer that arrives after that is dropped.

const maxTimeoutMs = 10_000;
const maxBytes = 1024 * 1024;

const netRequest = z.object({
  url: z.string().min(1).max(4096),
  method: z.enum(["GET", "POST"]).default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z
    .string()
    .max(64 * 1024)
    .optional(),
  timeoutMs: z.number().int().positive().optional(),
});

/** A request under way, which ends when the permission it needs goes. */
export type Watched = { signal: AbortSignal; done: () => void };

/** What an app holds while its request is under way. */
export type NetHolds = {
  // What it may do now, read again when the answer arrives.
  permissions: () => readonly string[];
  watch: (permission: string) => Watched;
};

export type NetFetch = (
  appId: string,
  holds: NetHolds,
  request: NetRequest,
) => Promise<NetResponse>;

/**
 * One app's requests under way, by the permission each needs, so taking
 * that permission away, or stopping the app, aborts them.
 */
export function createRequestsUnderWay(appId: string) {
  const underWay = new Map<AbortController, string>();

  function abort(matches: (permission: string) => boolean, reason: Error) {
    for (const [controller, permission] of underWay) {
      if (matches(permission)) {
        underWay.delete(controller);
        controller.abort(reason);
      }
    }
  }

  return {
    watch(permission: string): Watched {
      const controller = new AbortController();
      underWay.set(controller, permission);
      return {
        signal: controller.signal,
        done: () => void underWay.delete(controller),
      };
    },

    revoke(permission: string) {
      abort(
        (each) => each === permission,
        new Error(`${appId} no longer holds ${permission}`),
      );
    },

    // The app stopped.
    end() {
      abort(() => true, new Error(`${appId} stopped`));
    },
  };
}

export type RequestsUnderWay = ReturnType<typeof createRequestsUnderWay>;

// The answer's text, refusing more than maxBytes.
async function bodyOf(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("The answer is larger than 1 MB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createNet(fetcher: typeof fetch): NetFetch {
  return async (appId, holds, input) => {
    const request = netRequest.safeParse(input);
    if (!request.success) {
      throw new Error(`${appId} asked for a request the core cannot send`);
    }
    let url: URL;
    try {
      url = new URL(request.data.url);
    } catch {
      throw new Error(`${appId} asked for something that is not a URL`);
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error(
        `${appId} may fetch https: URLs only, without credentials`,
      );
    }
    // An address written into the URL is checked here, and a name as the
    // connection is made.
    const address = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(address) && !isPublicAddress(address)) {
      throw new Error(`${appId} may fetch from the public internet only`);
    }
    // The host as the permission names it, with a port other than 443.
    const permission = netPermission(url.host);
    if (!holds.permissions().includes(permission)) {
      throw new Error(`${appId} does not hold ${permission}`);
    }
    const watched = holds.watch(permission);
    try {
      const response = await fetcher(url, {
        method: request.data.method,
        headers: request.data.headers,
        body: request.data.body,
        redirect: "error",
        signal: AbortSignal.any([
          watched.signal,
          AbortSignal.timeout(
            Math.min(request.data.timeoutMs ?? maxTimeoutMs, maxTimeoutMs),
          ),
        ]),
      });
      const answer = {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await bodyOf(response),
      };
      watched.signal.throwIfAborted();
      if (!holds.permissions().includes(permission)) {
        throw new Error(`${appId} no longer holds ${permission}`);
      }
      return answer;
    } catch (error) {
      throw watched.signal.aborted ? watched.signal.reason : error;
    } finally {
      watched.done();
    }
  };
}
