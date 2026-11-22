import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// What the connector keeps on this computer: one file per connection, and
// each agent's token in the system's secure storage, or a file readable only
// by this user where there's none. The agent's own config holds neither the
// token nor anything that opens the home.

export type AgentKind = "claude" | "codex";

/** A connection to a home, one per agent added. */
export type Connection = {
  /** The agent's client id in Sanctum; its token is kept under it. */
  clientId: string;
  /** The name the agent registered the server as, such as `sanctum-office`. */
  name: string;
  agent: AgentKind | null;
  homeId: string;
  /** The home's host CA; none for a development core on this computer. */
  anchor: { pin: string; caCertificate: string } | null;
  /** Where the home answered last. */
  url: string;
};

/** The folder the connector keeps its files in. */
export function storeDir(env: NodeJS.ProcessEnv = process.env) {
  if (env.SANCTUM_MCP_DIR) return env.SANCTUM_MCP_DIR;
  if (process.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "Sanctum MCP");
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sanctum-mcp");
}

const aClientId = /^[0-9A-Za-z-]{8,64}$/;

function connectionPath(dir: string, clientId: string) {
  if (!aClientId.test(clientId)) throw new Error("Not a connection's id");
  return join(dir, "connections", `${clientId}.json`);
}

export async function saveConnection(dir: string, connection: Connection) {
  await mkdir(join(dir, "connections"), { recursive: true, mode: 0o700 });
  await writeFile(
    connectionPath(dir, connection.clientId),
    `${JSON.stringify(connection, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function loadConnection(
  dir: string,
  clientId: string,
): Promise<Connection | undefined> {
  try {
    return JSON.parse(await readFile(connectionPath(dir, clientId), "utf8"));
  } catch {
    return undefined;
  }
}

/** Every connection kept here. */
export async function listConnections(dir: string): Promise<Connection[]> {
  let files: string[];
  try {
    files = await readdir(join(dir, "connections"));
  } catch {
    return [];
  }
  const connections = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) => loadConnection(dir, file.slice(0, -".json".length))),
  );
  return connections.filter((each) => each !== undefined);
}

export async function removeConnection(dir: string, clientId: string) {
  await rm(connectionPath(dir, clientId), { force: true });
}

/** Where tokens are kept, and how to reach them. */
export type TokenStore = {
  /** "keychain" for the system's secure storage, "file" for the fallback. */
  kind: "keychain" | "file";
  get(clientId: string): Promise<string | undefined>;
  set(clientId: string, token: string): Promise<void>;
  delete(clientId: string): Promise<void>;
};

const service = "Sanctum MCP";

// The system's secure storage: the Keychain on a Mac, the Credential
// Manager on Windows, the Secret Service on Linux. None where the module or
// the service is missing, as over SSH or in a container.
async function keychain(): Promise<TokenStore | undefined> {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    // Reading proves the service answers before a token is trusted to it.
    new Entry(service, "probe").getPassword();
    return {
      kind: "keychain",
      async get(clientId) {
        return new Entry(service, clientId).getPassword() ?? undefined;
      },
      async set(clientId, token) {
        new Entry(service, clientId).setPassword(token);
      },
      async delete(clientId) {
        try {
          new Entry(service, clientId).deletePassword();
        } catch {
          // Already gone.
        }
      },
    };
  } catch {
    return undefined;
  }
}

/** Tokens in files only this user can read, under the store's folder. */
export function fileTokens(dir: string): TokenStore {
  const path = (clientId: string) => {
    if (!aClientId.test(clientId)) throw new Error("Not a connection's id");
    return join(dir, "tokens", clientId);
  };
  return {
    kind: "file",
    async get(clientId) {
      try {
        return (await readFile(path(clientId), "utf8")).trim() || undefined;
      } catch {
        return undefined;
      }
    },
    async set(clientId, token) {
      await mkdir(join(dir, "tokens"), { recursive: true, mode: 0o700 });
      await writeFile(path(clientId), token, { mode: 0o600 });
    },
    async delete(clientId) {
      await rm(path(clientId), { force: true });
    },
  };
}

/** The system's secure storage where there's one, else files. */
export async function tokenStore(dir: string): Promise<TokenStore> {
  return (await keychain()) ?? fileTokens(dir);
}
