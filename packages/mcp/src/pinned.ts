import {
  checkHostChain,
  presentedAnchor,
  type HostAnchor,
} from "@meetsanctum/auth-protocol/host-chain";
import { once } from "node:events";
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

/**
 * A fetch for one home. `onAnchor` hears when a certificate matching the
 * pin is first seen or reissued, for the connection to keep.
 */
export function pinnedFetch(
  trust: Trust,
  onAnchor?: (anchor: HostAnchor) => void | Promise<void>,
): typeof fetch {
  let anchor = trust.anchor;
  return async (input, init) => {
    const target = new Request(input, init);
    const url = new URL(target.url);
    if (trust.pin === null) {
      if (!isLoopback(url)) throw new PinMismatch(url.origin);
      return fetch(target, { redirect: "error" });
    }
    if (url.protocol !== "https:") throw new PinMismatch(url.origin);
    target.signal.throwIfAborted();
    const socket = connect({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || 443),
      // The pin decides, below; nothing is sent before it has.
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });
    // Keep socket errors handled between the handshake and HTTP request.
    const handleSocketError = () => undefined;
    socket.on("error", handleSocketError);
    try {
      await once(socket, "secureConnect", {
        signal: AbortSignal.any([target.signal, AbortSignal.timeout(5_000)]),
      });
      const chain = presentedChain(socket);
      const passed = anchor
        ? await checkHostChain(chain, anchor)
        : await presentedAnchor(chain).then((presented) =>
            presented?.pin === trust.pin ? presented.caCertificate : undefined,
          );
      if (!passed) throw new PinMismatch(url.origin);
      if (!anchor || anchor.caCertificate !== passed) {
        const seen = { pin: trust.pin, caCertificate: passed };
        await onAnchor?.(seen);
        anchor = seen;
      }
      return await send(target, url, socket);
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      socket.off("error", handleSocketError);
    }
  };
}

async function send(target: Request, url: URL, socket: TLSSocket) {
  const body =
    target.body === null ? undefined : Buffer.from(await target.arrayBuffer());
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
        if (status < 200 || status > 599) {
          incoming.resume();
          reject(new Error(`The home returned HTTP ${status}`));
          return;
        }
        if (
          [301, 302, 303, 307, 308].includes(status) &&
          headers.has("location")
        ) {
          incoming.resume();
          reject(new Error("The home redirected the request"));
          return;
        }
        const empty =
          target.method === "HEAD" || [204, 205, 304].includes(status);
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
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}
