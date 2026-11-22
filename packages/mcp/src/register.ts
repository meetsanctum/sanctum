import spawn from "cross-spawn";

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
export function serveCommand(
  clientId: string,
  local?: string,
  platform = process.platform,
): string[] {
  const serve = ["serve", "--connection", clientId];
  if (local) return [process.execPath, local, ...serve];
  const npx = ["npx", "-y", `@meetsanctum/mcp@${connectorVersion}`, ...serve];
  // The agent needs a real executable on Windows: npx is a .cmd shim.
  return platform === "win32" ? ["cmd.exe", "/d", "/c", ...npx] : npx;
}

/** The agent's commands to add, and first remove, a server by name. */
export function registration(
  agent: AgentKind,
  name: string,
  command: string[],
  storeOverride?: string,
) {
  const env = storeOverride
    ? ["--env", `SANCTUM_MCP_DIR=${storeOverride}`]
    : [];
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
          ...env,
          "--",
          ...command,
        ],
      }
    : {
        remove: ["codex", "mcp", "remove", name],
        add: ["codex", "mcp", "add", name, ...env, "--", ...command],
      };
}

export type Run = (command: string[]) => Promise<void>;

export const run: Run = (command) =>
  new Promise((resolve, reject) => {
    const [file, ...args] = command;
    if (!file || command.some((part) => /[\r\n]/.test(part))) {
      reject(new Error("Invalid registration command"));
      return;
    }
    const child = spawn(file, args, {
      timeout: 30_000,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_192);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            stderr.trim() || `${file} couldn't register the connector.`,
          ),
        );
    });
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
  previousCommand?: string[],
  storeOverride?: string,
) {
  const commands = registration(agent, name, command, storeOverride);
  // Codex updates an existing registration with add. Claude requires remove.
  if (agent !== "claude" || !previousCommand) {
    await runCommand(commands.add);
    return;
  }
  const replaced = await runCommand(commands.remove).then(
    () => true,
    () => false,
  );
  try {
    await runCommand(commands.add);
  } catch (error) {
    if (replaced) {
      try {
        await runCommand(
          registration(agent, name, previousCommand, storeOverride).add,
        );
      } catch {
        throw new Error(
          "Couldn't register the connector or restore its previous registration.",
        );
      }
    }
    throw error;
  }
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
export function shown(command: string[], platform = process.platform) {
  if (platform === "win32") {
    return `& ${command.map((part) => `'${part.replace(/'/g, "''")}'`).join(" ")}`;
  }
  return command
    .map((part) =>
      /^[\w@./:=+-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`,
    )
    .join(" ");
}
