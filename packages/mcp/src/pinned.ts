import {
  checkHostChain,
  presentedAnchor,
  type HostAnchor,
} from "@meetsanctum/auth-protocol/host-chain";
import { request } from "node:http";
import { Readable } from "node:stream";
import {
  connect,
  type DetailedPeerCertificate,
  type TLSSocket,
} from "node:tls";

// Every request the connector makes to a home goes through here. Over HTTPS
// it checks the chain the home presents against the pin before it writes
// anything, the same check the desktop app makes: names aren't checked and
// the system's trusted roots play no part. Plain HTTP is only for a
// development core on this computer, whose setup code carries no pin.

/** What a connection must match: the home's pin, and its CA once seen. */
export type Trust =
  { pin: string; anchor?: HostAnchor } | { pin: null; anchor?: undefined };

export class PinMismatch extends Error {
  constructor(readonly url: string) {
    super(`The computer at ${url} isn't this home`);
  }
}

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a URL may carry requests without a pin. */
export function isLoopback(url: URL) {
  return url.protocol === "http:" && loopback.has(url.hostname);
}

function pem(der: Buffer) {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

// The certificates the home presented, its own first.
function presentedChain(socket: TLSSocket) {
  const chain: string[] = [];
  const seen = new Set<string>();
  let certificate: DetailedPeerCertificate | undefined =
    socket.getPeerCertificate(true);
  while (certificate?.raw && !seen.has(certificate.fingerprint256)) {
    seen.add(certificate.fingerprint256);
    chain.push(pem(certificate.raw));
    certificate = certificate.issuerCertificate;
  }
  return chain;
}

function secureSocket(url: URL): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || 443),
      // The pin decides, below; nothing is sent before it has.
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/**
 * A fetch for one home. `onAnchor` hears the CA the home presented the
 * first time it passes the pin, for the connection to keep.
 */
export function pinnedFetch(
  trust: Trust,
  onAnchor?: (anchor: HostAnchor) => void,
): typeof fetch {
  let anchor = trust.anchor;
  return async (input, init) => {
    const target = new Request(input, init);
    const url = new URL(target.url);
    if (trust.pin === null) {
      if (!isLoopback(url)) throw new PinMismatch(url.origin);
      return fetch(target);
    }
    if (url.protocol !== "https:") throw new PinMismatch(url.origin);

    const socket = await secureSocket(url);
    const chain = presentedChain(socket);
    let passed: string | undefined;
    if (anchor) {
      passed = await checkHostChain(chain, anchor);
    } else {
      const presented = await presentedAnchor(chain);
      passed =
        presented?.pin === trust.pin ? presented.caCertificate : undefined;
    }
    if (!passed) {
      socket.destroy();
      throw new PinMismatch(url.origin);
    }
    if (!anchor || anchor.caCertificate !== passed) {
      anchor = { pin: trust.pin, caCertificate: passed };
      onAnchor?.(anchor);
    }

    const body =
      target.body === null
        ? undefined
        : Buffer.from(await target.arrayBuffer());
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        {
          method: target.method,
          host: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: {
            ...Object.fromEntries(target.headers),
            host: url.host,
            ...(body && { "content-length": String(body.length) }),
          },
          createConnection: () => socket,
          signal: target.signal,
        },
        (incoming) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            for (const each of [value].flat()) {
              if (each !== undefined) headers.append(name, each);
            }
          }
          const status = incoming.statusCode ?? 502;
          const empty = status === 204 || status === 304;
          if (empty) incoming.resume();
          resolve(
            new Response(
              empty
                ? null
                : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
              { status, headers },
            ),
          );
        },
      );
      outgoing.once("error", (error) => {
        socket.destroy();
        reject(error);
      });
      outgoing.end(body);
    });
  };
}
