import { request } from "node:https";

import type { Fetch } from "../socket.js";

// The manager checks the core's health over HTTPS like any client, trusting
// only the host CA: the core's certificate carries the loopback names
// (host-ca.ts), so the usual name check passes. A plain-HTTP URL, as under
// `pnpm dev`, is fetched as it is.
export function coreFetch(ca: () => string): Fetch {
  return (url, init = {}) => {
    if (!url.startsWith("https:")) {
      return fetch(url, init);
    }
    return new Promise((resolve, reject) => {
      const fail = (error: Error) =>
        reject(
          init.signal?.aborted
            ? init.signal.reason
            : new TypeError("fetch failed", { cause: error }),
        );
      const outgoing = request(
        url,
        {
          method: init.method ?? "GET",
          headers: Object.fromEntries(new Headers(init.headers)),
          signal: init.signal ?? undefined,
          ca: ca(),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", fail);
          response.on("end", () => {
            const status = response.statusCode ?? 500;
            const body = [204, 304].includes(status)
              ? null
              : Buffer.concat(chunks);
            resolve(new Response(body, { status }));
          });
        },
      );
      outgoing.on("error", fail);
      outgoing.end(typeof init.body === "string" ? init.body : undefined);
    });
  };
}
