import {
  parseAgentSetupCode,
  type AgentTokenCollected,
  type AuthErrorCode,
  type Platform,
} from "@meetsanctum/auth-protocol";
import type { HostAnchor } from "@meetsanctum/auth-protocol/host-chain";

import { discover, findHome, HomeNotFound } from "./find.js";
import { connectHome, homeName, isTokenRefused } from "./home.js";
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
  tokenStore,
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
    "That isn't a Sanctum setup code. Copy the prompt again from Sanctum's Settings, under AI Agents, Add an agent.",
  noPin:
    "This setup code is from a development home on another computer, which it can't check. Use one from a home on this network.",
  unreachable:
    "Couldn't reach Sanctum. Check this computer is on the home's network and Sanctum is running, then run this again.",
  notThisHome:
    "Found a computer on the network that isn't this home, so nothing was sent to it.",
  expired:
    "This setup has run out or was already used. Start a new one in Sanctum's Settings, under AI Agents, Add an agent.",
  tooNew:
    "This connector is newer than Sanctum. Update Sanctum, then add the agent again.",
  tooOld:
    "This connector is too old for Sanctum. Add the agent again from Sanctum's Settings, which gives the current connector.",
  keptPrevious: (name: string) =>
    `Sanctum didn't answer the agent's first call, so the agent keeps its earlier connection to this home, “${name}”. If Settings lists the new agent too, remove it there, under AI Agents. To try again, start a new setup there.`,
  firstCallFailed:
    "Sanctum didn't answer the agent's first call. If Settings doesn't show the agent connected, start a new setup there, under AI Agents, Add an agent, and run this again with its code.",
  tooManyAttempts:
    "Sanctum is holding this computer back after too many wrong codes. Wait 15 minutes, then try again.",
};

const refusals: Partial<Record<AuthErrorCode, string>> = {
  expired: connectWords.expired,
  connector_too_new: connectWords.tooNew,
  connector_too_old: connectWords.tooOld,
  too_many_attempts: connectWords.tooManyAttempts,
  busy: "Sanctum is busy handling setup requests. Wait a few minutes, then try again.",
};

export type ConnectOptions = {
  dir: string;
  storeOverride?: string;
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
  /** Whether the agent's first call through the connector went through. */
  firstCall: boolean;
  /** The home never saw the new token, so the earlier connection stays. */
  keptPrevious?: boolean;
  /** The agent's commands, run already when it's known. */
  registration: {
    add: string[];
    remove?: string[];
    registered: boolean;
    problem?: string;
  }[];
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
  const fetchHome = pinnedFetch(trust, (seen) => {
    anchor = seen;
  });
  let url: string;
  try {
    url = await findHome(
      code.homeId,
      fetchHome,
      code.pin ? () => (options.discover ?? discover)(code.homeId) : [],
      [code.url],
    );
  } catch (error) {
    if (error instanceof HomeNotFound) {
      throw new ConnectError(
        error.mismatched ? connectWords.notThisHome : connectWords.unreachable,
      );
    }
    throw error;
  }

  const response = await fetchHome(new URL("/api/auth/agents/collect", url), {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      setupId: code.setupId,
      secret: code.secret,
      platform: options.platform,
      protocol: connectorProtocol,
    }),
  });
  const body = (await response.json().catch(() => null)) as
    (Partial<AgentTokenCollected> & { error?: AuthErrorCode }) | null;
  if (
    !response.ok ||
    typeof body?.token !== "string" ||
    typeof body.agent?.id !== "string"
  ) {
    const refusal = body?.error;
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
    tokenStorage: options.tokens.kind,
    homeId: code.homeId,
    anchor,
    url,
  };
  try {
    await saveConnection(options.dir, connection);
  } catch (error) {
    await options.tokens.delete(clientId);
    throw error;
  }

  // The agent's first call, which Settings waits for. Once the token is
  // collected it's kept, whatever happens to this call: the home may have
  // seen the agent already, so Settings shows it connected. If it didn't,
  // the setup runs out, the home takes the token back, and `serve` tells
  // the agent it was removed, so the person adds it again.
  let name: string | undefined;
  let firstCall = true;
  // Whether the home took the token: any answer but a refusal means it
  // checked it and saw the agent. A refusal means the setup ran out or was
  // cancelled after the collect. An answer lost on the way back can't be
  // told apart from none; the agent then shows in Settings, to remove there.
  let reached = false;
  const answered: typeof fetch = async (input, init) => {
    const response = await fetchHome(input, init);
    if (response.status !== 401) reached = true;
    return response;
  };
  try {
    const client = await connectHome({
      url,
      token: body.token,
      fetch: answered,
    });
    try {
      await client.listTools();
      name = await homeName(client).catch(() => undefined);
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (error) {
    firstCall = false;
    if (isTokenRefused(error)) {
      await options.tokens.delete(clientId).catch(() => undefined);
      await removeConnection(options.dir, clientId).catch(() => undefined);
      throw new ConnectError(connectWords.expired);
    }
  }

  const choice = await chooseRegistration(
    options.dir,
    serverName(name),
    connection,
  );
  // A new token the home never saw runs out with its setup, so it doesn't
  // replace a connection to this home that works: that one stays, and the
  // new token is forgotten.
  if (!reached && choice.previous) {
    await options.tokens.delete(clientId).catch(() => undefined);
    await removeConnection(options.dir, clientId).catch(() => undefined);
    return {
      connection: choice.previous,
      homeName: name,
      firstCall,
      keptPrevious: true,
      registration: [],
    };
  }
  connection = { ...connection, name: choice.name, anchor };
  await saveConnection(options.dir, connection);

  const command = serveCommand(clientId, options.local);
  const agents: AgentKind[] = options.agent
    ? [options.agent]
    : ["claude", "codex"];
  const registered: Connected["registration"] = [];
  for (const agent of agents) {
    const { add, remove } = registration(
      agent,
      connection.name,
      command,
      options.storeOverride,
    );
    if (!options.agent) {
      registered.push({ add, registered: false });
      continue;
    }
    try {
      await register(
        agent,
        connection.name,
        command,
        options.run,
        choice.previous?.registeredCommand,
        options.storeOverride,
      );
      registered.push({ add, registered: true });
    } catch (error) {
      registered.push({
        add,
        remove: agent === "claude" && choice.previous ? remove : undefined,
        registered: false,
        problem: (error as Error).message,
      });
    }
  }
  if (registered.some((each) => each.registered)) {
    connection = { ...connection, registeredCommand: command };
    await saveConnection(options.dir, connection);
    if (choice.previous) {
      const previousStore =
        choice.previous.tokenStorage &&
        choice.previous.tokenStorage !== options.tokens.kind
          ? await tokenStore(options.dir, choice.previous.tokenStorage)
          : options.tokens;
      await previousStore.delete(choice.previous.clientId);
      await removeConnection(options.dir, choice.previous.clientId);
    }
  }
  return { connection, homeName: name, firstCall, registration: registered };
}

// A name of its own for each home, so adding a second one doesn't replace
// the first; adding the same home to the same agent again replaces the
// connection it had.
async function chooseRegistration(
  dir: string,
  name: string,
  connection: Connection,
) {
  const others = (await listConnections(dir)).filter(
    (other) =>
      other.clientId !== connection.clientId &&
      (other.agent === null ||
        connection.agent === null ||
        other.agent === connection.agent),
  );
  const previous = others.find(
    (other) =>
      connection.agent !== null &&
      other.agent === connection.agent &&
      other.homeId === connection.homeId &&
      other.registeredCommand,
  );
  if (previous) {
    return { name: previous.name, previous };
  }
  const taken = new Set(others.map((other) => other.name));
  let candidate = name;
  for (let count = 2; taken.has(candidate); count += 1) {
    candidate = `${name}-${count}`;
  }
  return { name: candidate };
}

/** What `connect` prints, for the agent to act on and pass on. */
export function connectedWords(connected: Connected, tokens: TokenStore) {
  const { connection, homeName: home, registration: commands } = connected;
  if (connected.keptPrevious) return connectWords.keptPrevious(connection.name);
  const lines = [
    connected.firstCall
      ? `Connected to ${home ?? "the home"} as the MCP server “${connection.name}”.`
      : `Set up the MCP server “${connection.name}”. ${connectWords.firstCallFailed}`,
  ];
  const done = commands.find((each) => each.registered);
  if (done) {
    lines.push(
      "Its tools are there from the agent's next session. Tell the person it's connected; what you can do is decided in Sanctum's Settings, under AI Agents.",
    );
  } else {
    const first = commands[0]!;
    lines.push(
      commands.length === 1
        ? `Couldn't register it with the agent (${first.problem ?? "unknown"}). Use the following command${first.remove ? "s" : ""} to register it:`
        : "Register it with the agent that ran this. For Claude Code:",
    );
    if (first.remove) lines.push(`  ${shown(first.remove)}`);
    lines.push(`  ${shown(first.add)}`);
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
