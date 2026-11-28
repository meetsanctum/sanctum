import { chmod, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";

import { AuthError } from "./auth/errors.js";

// The core's door for commands run on the host, inside its own container:
// a Unix socket in its data folder that only the container's own user can
// open, so only someone who can run commands on the host gets through. It
// lists who signs in and makes a code for a new password for one of them
// (cli.ts), for someone with no other way back in. Nothing on the network
// reaches it.

export function localSocketPath(dataDir: string) {
  return join(dataDir, "core.sock");
}

export type LocalAccess = {
  signIns(): { name: string; username: string }[];
  makeCode(username: string): Promise<{
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
      if (request.method === "POST" && request.url === "/recovery-code") {
        const input = await body(request);
        const username =
          input && typeof input === "object" && "username" in input
            ? input.username
            : undefined;
        if (typeof username !== "string") {
          throw new AuthError("invalid_request");
        }
        return send(200, await access.makeCode(username));
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
    // A socket left by a core that stopped without closing it goes first.
    async listen() {
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
