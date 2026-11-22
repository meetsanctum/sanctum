import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { connectorVersion } from "./version.js";

// The connector's own MCP client towards the home: the 2026-07-28 revision,
// stateless, over the pinned fetch, with the agent's token.

export class TokenRefused extends Error {
  constructor() {
    super("The home refused this agent's token");
  }
}

/** A fetch that turns the home's 401 into TokenRefused. */
function refusing(fetchHome: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchHome(input, init);
    if (response.status === 401) throw new TokenRefused();
    return response;
  };
}

export async function connectHome(options: {
  url: string;
  token: string;
  fetch: typeof fetch;
}) {
  const client = new Client(
    { name: "sanctum-mcp", version: connectorVersion },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/api/mcp", options.url), {
      requestInit: { headers: { authorization: `Bearer ${options.token}` } },
      fetch: refusing(options.fetch),
    }),
  );
  return client;
}

/** The home's name, from its overview, or none if it can't be read. */
export async function homeName(client: Client): Promise<string | undefined> {
  const result = await client.callTool({ name: "home_overview" });
  const home = (result.structuredContent as { home?: { name?: unknown } })
    ?.home;
  return typeof home?.name === "string" ? home.name : undefined;
}
