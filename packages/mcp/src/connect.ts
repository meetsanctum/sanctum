import {
  parseAgentSetupCode,
  type AgentTokenCollected,
  type AuthErrorCode,
  type Platform,
} from "@meetsanctum/auth-protocol";
import type { HostAnchor } from "@meetsanctum/auth-protocol/host-chain";

import { discover, findHome, HomeNotFound } from "./find.js";
import { connectHome, homeName } from "./home.js";
import { isLoopback, pinnedFetch, type Trust } from "./pinned.js";
import {
  register,
  registration,
  serveCommand,
  serverName,
  shown,
  type Run,
} from "./register.js";
import {
  listConnections,
  removeConnection,
  saveConnection,
  type AgentKind,
  type Connection,
  type TokenStore,
} from "./store.js";
import { connectorProtocol } from "./version.js";

// Adding an agent with a setup's code: the connector finds the home the code
// names and checks its pin before it sends the code's secret, keeps the
// token it gets, makes the agent's first call so Settings shows it
// connected, and registers itself with the agent. What it prints is for the
// agent to act on and tell the person.

export class ConnectError extends Error {}

export const connectWords = {
  notACode:
    "That isn't a Sanctum setup code. Copy the prompt again from Sanctum's Settings, under AI agents, Add an agent.",
  noPin:
    "This setup code is from a development home on another computer, which it can't check. Use one from a home on this network.",
  unreachable:
    "Couldn't reach Sanctum. Check this computer is on the home's network and Sanctum is running, then run this again.",
  notThisHome:
    "Found a computer on the network that isn't this home, so nothing was sent to it.",
  expired:
    "This setup has run out or was already used. Start a new one in Sanctum's Settings, under AI agents, Add an agent.",
  tooNew:
    "This connector is newer than Sanctum. Update Sanctum, then add the agent again.",
  tooOld:
    "This connector is too old for Sanctum. Add the agent again from Sanctum's Settings, which gives the current connector.",
  tooManyAttempts:
    "Sanctum is holding this computer back after too many wrong codes. Wait 15 minutes, then try again.",
};

const refusals: Partial<Record<AuthErrorCode, string>> = {
  expired: connectWords.expired,
  connector_too_new: connectWords.tooNew,
  connector_too_old: connectWords.tooOld,
  too_many_attempts: connectWords.tooManyAttempts,
  busy: connectWords.tooManyAttempts,
};

export type ConnectOptions = {
  dir: string;
  tokens: TokenStore;
  agent: AgentKind | null;
  platform: Platform;
  /** This script, to register instead of the published package. */
  local?: string;
  discover?: (homeId: string) => Promise<string[]>;
  run?: Run;
};

export type Connected = {
  connection: Connection;
  homeName: string | undefined;
  /** The agent's commands, run already when it's known. */
  registration: { add: string[]; registered: boolean; problem?: string }[];
};

export async function connect(
  codeText: string,
  options: ConnectOptions,
): Promise<Connected> {
  const code = parseAgentSetupCode(codeText);
  if (!code) throw new ConnectError(connectWords.notACode);
  if (code.pin === null && !isLoopback(new URL(code.url))) {
    throw new ConnectError(connectWords.noPin);
  }

  let anchor: HostAnchor | null = null;
  const trust: Trust = code.pin ? { pin: code.pin } : { pin: null };
  const fetchFor = () =>
    pinnedFetch(trust, (seen) => {
      anchor = seen;
    });
  let url: string;
  try {
    ({ url } = await findHome(
      code.homeId,
      [
        ...(code.pin ? await (options.discover ?? discover)(code.homeId) : []),
        code.url,
      ],
      fetchFor,
    ));
  } catch (error) {
    if (error instanceof HomeNotFound) {
      throw new ConnectError(
        error.mismatched ? connectWords.notThisHome : connectWords.unreachable,
      );
    }
    throw error;
  }

  const response = await fetchFor()(new URL("/api/auth/agents/collect", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      setupId: code.setupId,
      secret: code.secret,
      platform: options.platform,
      protocol: connectorProtocol,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as
    AgentTokenCollected | { error?: AuthErrorCode };
  if (!response.ok || !("token" in body)) {
    const refusal = "error" in body ? body.error : undefined;
    throw new ConnectError(
      (refusal && refusals[refusal]) ??
        `Sanctum refused the setup (${refusal ?? response.status}).`,
    );
  }

  const clientId = body.agent.id;
  await options.tokens.set(clientId, body.token);
  let connection: Connection = {
    clientId,
    name: "sanctum",
    agent: options.agent,
    homeId: code.homeId,
    anchor,
    url,
  };
  await saveConnection(options.dir, connection);

  // The agent's first call, which Settings waits for.
  const client = await connectHome({
    url,
    token: body.token,
    fetch: fetchFor(),
  });
  await client.listTools();
  const name = await homeName(client).catch(() => undefined);
  await client.close();

  connection = {
    ...connection,
    name: await uniqueName(options, serverName(name), connection),
  };
  await saveConnection(options.dir, connection);

  const command = serveCommand(clientId, options.local);
  const agents: AgentKind[] = options.agent
    ? [options.agent]
    : ["claude", "codex"];
  const registered: Connected["registration"] = [];
  for (const agent of agents) {
    const { add } = registration(agent, connection.name, command);
    if (!options.agent) {
      registered.push({ add, registered: false });
      continue;
    }
    try {
      await register(agent, connection.name, command, options.run);
      registered.push({ add, registered: true });
    } catch (error) {
      registered.push({
        add,
        registered: false,
        problem: (error as Error).message,
      });
    }
  }
  return { connection, homeName: name, registration: registered };
}

// A name of its own for each home, so adding a second one doesn't replace
// the first; adding the same home to the same agent again replaces the
// connection it had.
async function uniqueName(
  { dir, tokens }: Pick<ConnectOptions, "dir" | "tokens">,
  name: string,
  connection: Connection,
) {
  const others = (await listConnections(dir)).filter(
    (other) =>
      other.clientId !== connection.clientId &&
      other.agent === connection.agent,
  );
  for (const other of others) {
    if (other.homeId === connection.homeId && other.name === name) {
      await tokens.delete(other.clientId);
      await removeConnection(dir, other.clientId);
    }
  }
  const taken = new Set(
    others
      .filter((other) => other.homeId !== connection.homeId)
      .map((other) => other.name),
  );
  let candidate = name;
  for (let count = 2; taken.has(candidate); count += 1) {
    candidate = `${name}-${count}`;
  }
  return candidate;
}

/** What `connect` prints, for the agent to act on and pass on. */
export function connectedWords(connected: Connected, tokens: TokenStore) {
  const { connection, homeName: home, registration: commands } = connected;
  const lines = [
    `Connected to ${home ?? "the home"} as the MCP server “${connection.name}”.`,
  ];
  const done = commands.find((each) => each.registered);
  if (done) {
    lines.push(
      "Its tools are there from the agent's next session. Tell the person it's connected; what you can do is decided in Sanctum's Settings, under AI agents.",
    );
  } else {
    lines.push(
      commands.length === 1
        ? `Couldn't register it with the agent (${commands[0]!.problem ?? "unknown"}). Run this to register it:`
        : "Register it with the agent that ran this. For Claude Code:",
    );
    lines.push(`  ${shown(commands[0]!.add)}`);
    if (commands[1]) {
      lines.push("For Codex:", `  ${shown(commands[1].add)}`);
    }
  }
  if (tokens.kind === "file") {
    lines.push(
      "There's no secure storage on this computer, so the agent's token is in a file only this user can read.",
    );
  }
  return lines.join("\n");
}
