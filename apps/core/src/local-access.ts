import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { AuthError } from "./auth/errors.js";

// The core's door for commands run on the host, inside its own container:
// a Unix socket outside its data volume that only the container's own user can
// open, so only someone who can run commands on the host gets through. It
// lists who signs in and makes a code for a new password for one of them
// (cli.ts), for someone with no other way back in. Nothing on the network
// reaches it.

export function localSocketPath(dataDir: string) {
  // Each core on the same machine gets a short socket path, outside backups.
  const instance = createHash("sha256")
    .update(resolve(dataDir))
    .digest("hex")
    .slice(0, 16);
  return join(
    tmpdir(),
    `sanctum-${process.getuid?.() ?? 0}-${instance}`,
    "core.sock",
  );
}

export type LocalAccess = {
  signIns(): { name: string; username: string }[];
  updatePending(): boolean;
  makeCode(
    username: string,
    replace: boolean,
  ): Promise<{
    code: string;
    name: string;
    endsAt: string;
  }>;
};

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 4096) throw new AuthError("invalid_request");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AuthError("invalid_request");
  }
}

export function createLocalAccess(
  path: string,
  access: LocalAccess,
  log: (message: string) => void,
) {
  const server = createServer((request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    void (async () => {
      if (request.method === "GET" && request.url === "/sign-ins") {
        return send(200, access.signIns());
      }
      if (request.method === "POST" && request.url === "/reset-code") {
        const input = await body(request);
        if (
          !input ||
          typeof input !== "object" ||
          !("username" in input) ||
          typeof input.username !== "string" ||
          ("replace" in input && typeof input.replace !== "boolean")
        ) {
          throw new AuthError("invalid_request");
        }
        if (access.updatePending()) {
          response.setHeader("retry-after", "5");
          return send(503, { error: "update_pending" });
        }
        const replace = "replace" in input && input.replace === true;
        return send(200, await access.makeCode(input.username, replace));
      }
      send(404, { error: "not_found" });
    })().catch((error: unknown) => {
      if (error instanceof AuthError) {
        send(error.status, { error: error.code });
      } else {
        log(`local access: ${String(error)}`);
        send(500, { error: "failed" });
      }
    });
  });

  return {
    async listen() {
      const folder = dirname(path);
      await mkdir(folder, { mode: 0o700, recursive: true });
      const permissions = await lstat(folder);
      if (
        !permissions.isDirectory() ||
        (permissions.mode & 0o077) !== 0 ||
        permissions.uid !== process.getuid?.()
      ) {
        throw new Error(
          "The local socket folder must be private to the core's user.",
        );
      }
      // A socket left by a core that stopped without closing it goes first.
      await rm(path, { force: true });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await chmod(path, 0o600);
    },
    close() {
      return new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
