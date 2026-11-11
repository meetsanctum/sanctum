import type { FastifyInstance } from "fastify";
import { chmod, chown, lstat, mkdir, rm } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { dirname } from "node:path";

// The manager's API listens only on a Unix socket, in a volume that only the
// core and the manager mount. Having the mount is the credential, so there is
// no port for services to reach and no secret.

// Whether a process answers on the socket, as opposed to a file a crash
// left behind.
function isAnswering(path: string) {
  return new Promise<boolean>((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });
}

// Listens on the socket: the manager's user and `groupId`, shared with the
// core's container, may connect (0660, in a 0750 directory). Without a group,
// only the manager's user may.
export async function listenOnSocket(
  server: FastifyInstance,
  path: string,
  groupId?: number,
) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  if (groupId !== undefined) {
    await chown(directory, process.getuid!(), groupId);
  }
  await chmod(directory, 0o750);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && !existing.isSocket()) {
    throw new Error(`Refusing to replace ${path}: not a socket`);
  }
  if (await isAnswering(path)) {
    throw new Error(`Another manager is listening on ${path}`);
  }
  await rm(path, { force: true });

  await server.listen({ path });
  if (groupId !== undefined) {
    await chown(path, process.getuid!(), groupId);
  }
  await chmod(path, 0o660);
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// A small fetch over a Unix socket, for calling the manager: the URL's path
// and query are sent, its host is ignored. Like fetch, it rejects with a
// TypeError when nothing answers, and with the signal's reason when aborted.
export function socketFetch(socketPath: string): Fetch {
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      const { pathname, search } = new URL(url);
      const fail = (error: Error) =>
        reject(
          init.signal?.aborted
            ? init.signal.reason
            : new TypeError("fetch failed", { cause: error }),
        );
      const outgoing = request(
        {
          socketPath,
          method: init.method ?? "GET",
          path: `${pathname}${search}`,
          headers: Object.fromEntries(new Headers(init.headers)),
          signal: init.signal ?? undefined,
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
}
