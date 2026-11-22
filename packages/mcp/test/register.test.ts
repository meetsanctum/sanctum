import { describe, expect, it } from "vitest";

import {
  agentFromEnv,
  register,
  registration,
  serveCommand,
  serverName,
  shown,
} from "../src/register.js";

// Registering the connector with the agent that ran it.

describe("registering with the agent", () => {
  it("knows the agent from what it puts in its commands' environment", () => {
    expect(agentFromEnv({ CLAUDECODE: "1" })).toBe("claude");
    expect(agentFromEnv({ CODEX_THREAD_ID: "019a" })).toBe("codex");
    expect(agentFromEnv({})).toBeNull();
  });

  it("names the server after the home", () => {
    expect(serverName("Office")).toBe("sanctum-office");
    expect(serverName("Zürich flat, 2nd floor")).toBe(
      "sanctum-zurich-flat-2nd-floor",
    );
    expect(serverName("  ")).toBe("sanctum");
    expect(serverName(undefined)).toBe("sanctum");
    expect(serverName("x".repeat(60))).toBe(`sanctum-${"x".repeat(32)}`);
  });

  it("starts the published version, or this script for one built from source", () => {
    expect(serveCommand("agent-1")).toEqual([
      "npx",
      "-y",
      "@meetsanctum/mcp@0.1.0",
      "serve",
      "--connection",
      "agent-1",
    ]);
    expect(serveCommand("agent-1", "/src/mcp/dist/cli.js")).toEqual([
      process.execPath,
      "/src/mcp/dist/cli.js",
      "serve",
      "--connection",
      "agent-1",
    ]);
  });

  it("replaces a server of the same name, with the agent's own commands", async () => {
    const ran: string[][] = [];
    const command = serveCommand("agent-1");

    await register("claude", "sanctum-office", command, async (each) => {
      ran.push(each);
      if (each[2] === "remove")
        throw new Error("No MCP server named sanctum-office");
    });

    expect(ran).toEqual([
      ["claude", "mcp", "remove", "--scope", "user", "sanctum-office"],
      [
        "claude",
        "mcp",
        "add",
        "--scope",
        "user",
        "sanctum-office",
        "--",
        ...command,
      ],
    ]);
    expect(registration("codex", "sanctum-office", command)).toEqual({
      remove: ["codex", "mcp", "remove", "sanctum-office"],
      add: ["codex", "mcp", "add", "sanctum-office", "--", ...command],
    });
  });

  it("fails when the agent won't add it", async () => {
    await expect(
      register("codex", "sanctum", ["npx"], async (each) => {
        if (each[2] === "add") throw new Error("codex: not found");
      }),
    ).rejects.toThrow("codex: not found");
  });

  it("shows a command as it would be typed", () => {
    expect(
      shown(["claude", "mcp", "add", "sanctum", "--", "/Program Files/node"]),
    ).toBe("claude mcp add sanctum -- '/Program Files/node'");
  });
});
