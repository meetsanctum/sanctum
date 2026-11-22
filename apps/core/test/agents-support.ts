import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import type { TestCore } from "./support.js";

// An AI agent's MCP client, the official SDK's own on the 2026-07-28
// revision, whose requests go to the core's own server.

function injected(core: TestCore, headers: Record<string, string> = {}) {
  return async (url: string | URL, init?: RequestInit) => {
    const target = new URL(url);
    const response = await core.server.inject({
      method: (init?.method ?? "GET") as "POST",
      url: target.pathname + target.search,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        ...headers,
      },
      payload: init?.body as string | undefined,
    });
    return new Response(response.rawPayload, {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
    });
  };
}

export async function connect(
  core: TestCore,
  token: string,
  headers: Record<string, string> = {},
) {
  const client = new Client(
    { name: "test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://sanctum.test/api/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: injected(core, headers),
    }),
  );
  return client;
}

export const names = async (client: Client) =>
  (await client.listTools(undefined, { cacheMode: "bypass" })).tools.map(
    (tool) => tool.name,
  );
