import { SdkHttpError, type Client } from "@modelcontextprotocol/client";
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from "@modelcontextprotocol/server";

import { discover, findHome, HomeNotFound } from "./find.js";
import { connectHome, isTokenRefused } from "./home.js";
import { pinnedFetch } from "./pinned.js";
import {
  loadConnection,
  removeConnection,
  saveConnection,
  tokenStore,
  type Connection,
  type TokenStore,
} from "./store.js";
import { connectorVersion } from "./version.js";

// What the agent runs: an MCP server on stdio that passes each tools/list
// and tools/call on to the home's endpoint, over the pinned connection. The
// agent may speak either revision (cli.ts serves both); towards the home
// it's always 2026-07-28. The home is found again whenever it stops
// answering where it was, and a refused token is forgotten, since the
// agent was removed in Settings.

const toolListTtlMs = 30_000;

export const words = {
  removed:
    "Sanctum no longer knows this agent: it was removed in Settings, under AI agents. Add it again there to connect.",
  unreachable:
    "Couldn't reach Sanctum. Check this computer is on the home's network, and that Sanctum is running.",
  notThisHome:
    "Found a computer on the network that isn't this home, so nothing was sent to it.",
  unconfirmed:
    "Couldn't confirm the result of this call. Check the home's state before trying again.",
};

export type ServeOptions = {
  dir: string;
  clientId: string;
  tokens?: TokenStore;
  /** Finds the home's addresses on the network; none in tests. */
  discover?: (homeId: string) => Promise<string[]>;
  log?: (message: string) => void;
};

/** One upstream connection to the home, made when first needed. */
export function homeLink(options: ServeOptions) {
  let client: Promise<Client> | undefined;
  let gone = false;
  let tokens = options.tokens;

  async function open(): Promise<Client> {
    const connection = await loadConnection(options.dir, options.clientId);
    if (connection)
      tokens ??= await tokenStore(options.dir, connection.tokenStorage);
    const token = await tokens?.get(options.clientId);
    if (!connection || !token) {
      gone = true;
      throw new Error(words.removed);
    }
    let current: Connection = connection;
    const trust = current.anchor
      ? { pin: current.anchor.pin, anchor: current.anchor }
      : { pin: null };
    let foundHome = false;
    const fetchHome = pinnedFetch(trust, async (anchor) => {
      // A reissued CA certificate, the same key with new dates.
      current = { ...current, anchor };
      if (foundHome && !gone) await saveConnection(options.dir, current);
    });
    const url = await findHome(
      current.homeId,
      fetchHome,
      [current.url],
      current.anchor
        ? () => (options.discover ?? discover)(current.homeId)
        : [],
    );
    current = { ...current, url };
    foundHome = true;
    if (
      !gone &&
      (url !== connection.url || current.anchor !== connection.anchor)
    ) {
      await saveConnection(options.dir, current);
    }
    if (gone) throw new Error(words.removed);
    return connectHome({ url, token, fetch: fetchHome });
  }

  async function forget() {
    gone = true;
    try {
      await tokens?.delete(options.clientId);
      await removeConnection(options.dir, options.clientId);
    } catch (error) {
      options.log?.(
        `Couldn't clear the removed agent's connection: ${(error as Error).message}`,
      );
    }
  }

  async function use<T>(
    work: (client: Client) => Promise<T>,
    retryRead = false,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      if (gone) throw new Error(words.removed);
      const opening = (client ??= open());
      let sent = false;
      try {
        const connected = await opening;
        if (gone) throw new Error(words.removed);
        sent = true;
        return await work(connected);
      } catch (error) {
        if (
          sent &&
          (error instanceof ProtocolError ||
            (error instanceof SdkHttpError &&
              error.status >= 400 &&
              error.status < 500))
        ) {
          throw error;
        }
        if (client === opening) client = undefined;
        if (isTokenRefused(error)) {
          await forget();
          throw new Error(words.removed);
        }
        if (error instanceof HomeNotFound) {
          throw new Error(
            error.mismatched ? words.notThisHome : words.unreachable,
          );
        }
        if (gone) throw new Error(words.removed);
        // A dropped answer can mean the tool ran. Only retry reads.
        if (sent && !retryRead) throw new Error(words.unconfirmed);
        if (attempt > 0) throw error;
        options.log?.(`Connecting again: ${(error as Error).message}`);
      }
    }
  }

  return { use };
}

/** The server one agent's connection gets, for either revision. */
export function connectorServer(link: ReturnType<typeof homeLink>) {
  const server = new Server(
    { name: "sanctum", version: connectorVersion },
    {
      capabilities: { tools: {} },
      cacheHints: {
        "tools/list": { ttlMs: toolListTtlMs, cacheScope: "private" },
      },
    },
  );
  server.setRequestHandler("tools/list", async (request) => {
    try {
      return await link.use(
        (client) => client.listTools(request.params, { cacheMode: "bypass" }),
        true,
      );
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        (error as Error).message,
      );
    }
  });
  server.setRequestHandler("tools/call", async (request) => {
    try {
      return await link.use((client) => client.callTool(request.params));
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      return {
        isError: true,
        content: [{ type: "text" as const, text: (error as Error).message }],
      };
    }
  });
  return server;
}
