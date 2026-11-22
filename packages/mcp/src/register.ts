import { execFile } from "node:child_process";

import type { AgentKind } from "./store.js";
import { connectorVersion } from "./version.js";

// Registering the connector with the agent that ran it, through the agent's
// own command for adding an MCP server. The registration names a pinned
// version and the connection's client id, and holds no secret: the token
// stays in the connector's storage.

/** The agent that ran this, from what each puts in its commands' environment. */
export function agentFromEnv(env: NodeJS.ProcessEnv): AgentKind | null {
  if (env.CLAUDECODE === "1") return "claude";
  if (env.CODEX_THREAD_ID) return "codex";
  return null;
}

/**
 * The command the agent starts the connector with: the published package at
 * this version, or this very script where it wasn't run from the package
 * (`--local`, for a connector built from source).
 */
export function serveCommand(clientId: string, local?: string): string[] {
  const serve = ["serve", "--connection", clientId];
  return local
    ? [process.execPath, local, ...serve]
    : ["npx", "-y", `@meetsanctum/mcp@${connectorVersion}`, ...serve];
}

/** The agent's commands to add, and first remove, a server by name. */
export function registration(
  agent: AgentKind,
  name: string,
  command: string[],
) {
  return agent === "claude"
    ? {
        remove: ["claude", "mcp", "remove", "--scope", "user", name],
        add: [
          "claude",
          "mcp",
          "add",
          "--scope",
          "user",
          name,
          "--",
          ...command,
        ],
      }
    : {
        remove: ["codex", "mcp", "remove", name],
        add: ["codex", "mcp", "add", name, "--", ...command],
      };
}

export type Run = (command: string[]) => Promise<void>;

export const run: Run = (command) =>
  new Promise((resolve, reject) => {
    const [file, ...args] = command;
    // On Windows the agents' commands and npx are scripts the shell finds.
    const shell = process.platform === "win32";
    execFile(
      file!,
      args,
      { timeout: 30_000, shell },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve();
      },
    );
  });

/**
 * Registers the connector as `name` with `agent`, replacing a server of
 * that name if there is one, such as from adding the agent before.
 */
export async function register(
  agent: AgentKind,
  name: string,
  command: string[],
  runCommand: Run = run,
) {
  const commands = registration(agent, name, command);
  await runCommand(commands.remove).catch(() => undefined);
  await runCommand(commands.add);
}

/** A name for the server from the home's, such as `sanctum-office`. */
export function serverName(homeName: string | undefined) {
  const slug = (homeName ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug ? `sanctum-${slug}` : "sanctum";
}

/** A command as it would be typed, for setting one up by hand. */
export function shown(command: string[]) {
  return command
    .map((part) =>
      /^[\w@./:=+-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`,
    )
    .join(" ");
}
