import {
  liveAuthTimeoutCode,
  liveAuthTimeoutMs,
  liveInvalidTokenCode,
  livePath,
  type LiveReady,
} from "@meetsanctum/auth-protocol";
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";

import type { Principal } from "./clients.js";

// The live-update WebSocket. Browsers cannot set headers on a WebSocket, so
// it authenticates with its first message, and receives nothing until then.
// Each connection stays tied to the client it authenticated as, and closes
// when that client is revoked or its person removed. Modules push updates to
// it, each connection getting only what its principal may see. Settings →
// Status lists the clients connected now.

const authMessage = z.object({ type: z.literal("auth"), token: z.string() });

type Socket = Pick<WebSocket, "close" | "send">;

export function createConnections(options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const open = new Map<Socket, { principal: Principal; since: Date }>();

  function close(matches: (principal: Principal) => boolean) {
    for (const [socket, { principal }] of open) {
      if (matches(principal)) {
        open.delete(socket);
        socket.close(liveInvalidTokenCode, "invalid_client_token");
      }
    }
  }

  return {
    add(principal: Principal, socket: Socket) {
      open.set(socket, { principal, since: now() });
      return () => {
        open.delete(socket);
      };
    },

    // Since when a client has been connected: its oldest connection still
    // open, for Settings → Status' Connected now.
    connectedSince(clientId: string) {
      let since: Date | null = null;
      for (const connection of open.values()) {
        if (
          connection.principal.client.id === clientId &&
          (!since || connection.since < since)
        ) {
          since = connection.since;
        }
      }
      return since;
    },

    closeClient(clientId: string) {
      close((principal) => principal.client.id === clientId);
    },

    // A removed person's clients are gone with them.
    closePerson(personId: string) {
      close((principal) => principal.person?.id === personId);
    },

    // Sends every open connection what `message` builds for its principal;
    // nothing where it builds nothing.
    publish(message: (principal: Principal) => object | undefined) {
      for (const [socket, { principal }] of open) {
        const built = message(principal);
        if (built) {
          try {
            socket.send(JSON.stringify(built));
          } catch {
            // A connection on its way out; its close event releases it.
          }
        }
      }
    },
  };
}

export type LiveConnections = ReturnType<typeof createConnections>;

function parse(raw: unknown) {
  try {
    return authMessage.safeParse(JSON.parse(String(raw))).data;
  } catch {
    return undefined;
  }
}

export async function registerLive(
  app: FastifyInstance,
  options: {
    authenticate: (token: string) => Principal | undefined;
    connections: LiveConnections;
  },
) {
  await app.register(websocket, { options: { maxPayload: 4_096 } });
  app.get(livePath, { websocket: true, config: { public: true } }, (socket) => {
    let release: (() => void) | undefined;
    const refuse = () =>
      socket.close(liveInvalidTokenCode, "invalid_client_token");
    const timer = setTimeout(
      () => socket.close(liveAuthTimeoutCode, "auth_timeout"),
      liveAuthTimeoutMs,
    );
    socket.on("message", (raw) => {
      if (release) {
        // Nothing else comes from clients.
        return;
      }
      clearTimeout(timer);
      const message = parse(raw);
      const principal = message && options.authenticate(message.token);
      if (!principal) {
        refuse();
        return;
      }
      release = options.connections.add(principal, socket);
      socket.send(JSON.stringify({ type: "ready" } satisfies LiveReady));
    });
    socket.on("close", () => {
      clearTimeout(timer);
      release?.();
    });
  });
}
