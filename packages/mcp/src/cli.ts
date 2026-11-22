#!/usr/bin/env node
import type { Platform } from "@meetsanctum/auth-protocol";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { connect, ConnectError, connectedWords } from "./connect.js";
import { agentFromEnv } from "./register.js";
import { connectorServer, homeLink } from "./serve.js";
import { storeDir, tokenStore } from "./store.js";
import { connectorVersion } from "./version.js";

// `sanctum-mcp connect <code>` adds the agent that runs it to a home, and
// `sanctum-mcp serve --connection <id>` is what that agent starts. Output is
// for the agent: it acts on it and tells the person.

const usage = `Connects an AI agent on this computer to Sanctum.

  sanctum-mcp connect <code> [--agent claude|codex] [--local]
      Adds this agent with the code from Sanctum's Settings, under AI agents,
      Add an agent, and registers the connector with the agent.
  sanctum-mcp serve --connection <id>
      The MCP server the agent starts, on stdio.
  sanctum-mcp --version`;

function platform(): Platform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      local: { type: "boolean" },
      connection: { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.version) {
    console.log(connectorVersion);
    return 0;
  }
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const storeOverride = process.env.SANCTUM_MCP_DIR
    ? resolve(storeDir())
    : undefined;
  const dir = storeOverride ?? storeDir();

  if (command === "connect" && rest.length === 1) {
    const agent = values.agent ?? agentFromEnv(process.env);
    if (agent !== null && agent !== "claude" && agent !== "codex") {
      console.error("Choose claude or codex for --agent.");
      return 1;
    }
    const tokens = await tokenStore(dir);
    try {
      const connected = await connect(rest[0]!, {
        dir,
        storeOverride,
        tokens,
        agent,
        platform: platform(),
        local: values.local
          ? realpathSync(fileURLToPath(import.meta.url))
          : undefined,
      });
      console.log(connectedWords(connected, tokens));
      return 0;
    } catch (error) {
      if (!(error instanceof ConnectError)) throw error;
      console.error(error.message);
      if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1") {
        console.error(
          "Codex's sandbox kept this command off the network: run it again with network access.",
        );
      }
      return 1;
    }
  }

  if (command === "serve" && rest.length === 0 && values.connection) {
    const link = homeLink({
      dir,
      clientId: values.connection,
      log: (message) => console.error(message),
    });
    serveStdio(() => connectorServer(link), {
      legacy: "serve",
      onerror: (error) => console.error(error.message),
    });
    return undefined;
  }

  console.error(usage);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (error: unknown) => {
    console.error((error as Error).message ?? error);
    process.exitCode = 1;
  },
);
