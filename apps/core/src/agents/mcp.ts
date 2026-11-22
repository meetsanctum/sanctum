import {
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { ActivityAuthor, NewActivityEntry } from "../activity/activity.js";
import type { Principal } from "../auth/clients.js";
import type { AgentLimiter, LimitRefusal } from "./limits.js";
import type { AgentTools } from "./tools.js";

// The MCP endpoint AI agents reach the home through, `POST /api/mcp`, on the
// 2026-07-28 revision of the protocol: stateless, each request on its own,
// with its method and version in headers that must agree with its body
// (400 and -32020 otherwise, as the SDK checks). Only an AI agent's token
// opens it, and nothing else opens with that token (auth/routes.ts).
//
// Requests with an `Origin` are refused so a browser page cannot call the
// home. Requests a minute and calls at once are held to limits (limits.ts),
// and an agent over one is logged once a minute. The tool list is short-lived
// and private, since it follows the household's switches.

type AgentPrincipal = Extract<Principal, { scope: "agent" }>;

/** How long an agent may keep a tool list before asking again. */
export const toolListTtlMs = 30_000;

function jsonRpcError(reply: FastifyReply, status: number, message: string) {
  return reply
    .code(status)
    .send({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

export function registerMcpRoute(
  app: FastifyInstance,
  options: {
    tools: AgentTools;
    limiter: AgentLimiter;
    record: (entry: NewActivityEntry) => string;
    agentWho: (id: string) => ActivityAuthor;
    isActiveAgent: (id: string) => boolean;
    version: string;
  },
) {
  const { tools, limiter } = options;

  function serverFor(principal: AgentPrincipal) {
    const server = new Server(
      { name: "sanctum", version: options.version },
      {
        capabilities: { tools: {} },
        cacheHints: {
          "tools/list": { ttlMs: toolListTtlMs, cacheScope: "private" },
        },
      },
    );
    server.setRequestHandler("tools/list", () => ({ tools: tools.list() }));
    server.setRequestHandler("tools/call", async (request) => {
      const { name, arguments: input } = request.params;
      const result = await tools.call(principal, name, input);
      if (!result) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown tool: ${name}`,
        );
      }
      return result;
    });
    return server;
  }

  const handler = createMcpHandler(
    (context) =>
      serverFor(context.authInfo?.extra?.principal as AgentPrincipal),
    { legacy: "reject" },
  );

  // An agent over a limit is logged at most once a minute.
  const lastLogged = new Map<string, number>();
  function logLimited(
    principal: AgentPrincipal,
    limited: LimitRefusal["limited"],
  ) {
    const at = performance.now();
    for (const [id, last] of lastLogged) {
      if (at - last < 60_000) break;
      lastLogged.delete(id);
    }
    if (lastLogged.has(principal.client.id)) return;
    lastLogged.set(principal.client.id, at);
    options.record({
      action: "agents.limited",
      outcome: "refused",
      reason: limited,
      ...options.agentWho(principal.client.id),
    });
  }

  function refuseLimit(
    reply: FastifyReply,
    principal: AgentPrincipal,
    refusal: LimitRefusal,
  ) {
    logLimited(principal, refusal.limited);
    return jsonRpcError(
      reply.header("retry-after", String(refusal.retryAfter)),
      429,
      refusal.limited === "per_minute"
        ? "Too many requests in the last minute"
        : "Too many requests at once",
    );
  }

  const route = {
    config: { agent: true },
    async onRequest(request: FastifyRequest, reply: FastifyReply) {
      const principal = request.principal;
      if (principal?.scope !== "agent") {
        return jsonRpcError(reply, 403, "Only an AI agent's token opens this");
      }
      if (request.headers.origin !== undefined) {
        return jsonRpcError(reply, 403, "Origin not allowed");
      }
      if (request.method === "POST") {
        const refusal = limiter.takeRequest(principal.client.id);
        if (refusal) return refuseLimit(reply, principal, refusal);
      }
    },
  };

  app.post("/api/mcp", route, async (request, reply) => {
    const principal = request.principal as AgentPrincipal;
    // An agent may have been removed while Fastify was reading its body.
    if (!options.isActiveAgent(principal.client.id)) {
      return reply.code(401).send({ error: "invalid_client_token" });
    }
    const admitted = limiter.begin(principal.client.id);
    if ("limited" in admitted) return refuseLimit(reply, principal, admitted);
    try {
      const response = await handler.fetch(webRequest(request), {
        authInfo: {
          token: "",
          clientId: principal.client.id,
          scopes: [],
          extra: { principal },
        },
        parsedBody: request.body,
      });
      reply.code(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(await response.text());
    } finally {
      admitted.done();
    }
  });

  // Stateless: there's no stream to open and no session to end.
  const notHere = async (_request: FastifyRequest, reply: FastifyReply) =>
    jsonRpcError(reply.header("allow", "POST"), 405, "Method not allowed");
  app.get("/api/mcp", route, notHere);
  app.delete("/api/mcp", route, notHere);
}

// The request as the SDK reads it: its headers, and the body Fastify parsed.
function webRequest(request: FastifyRequest) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || key === "authorization") continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Request(`http://${request.hostname}${request.url}`, {
    method: "POST",
    headers,
  });
}
