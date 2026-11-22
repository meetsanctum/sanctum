import { agentConnector } from "@meetsanctum/auth-protocol";
import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };

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

  it("is the package and version a setup's prompt runs", () => {
    expect(agentConnector).toEqual({
      name: manifest.name,
      version: manifest.version,
    });
  });

  it("starts the published version, or this script for one built from source", () => {
    expect(serveCommand("agent-1", undefined, "linux")).toEqual([
      "npx",
      "-y",
      `@meetsanctum/mcp@${manifest.version}`,
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
    expect(serveCommand("agent-1", undefined, "win32").slice(0, 4)).toEqual([
      "cmd.exe",
      "/d",
      "/c",
      "npx",
    ]);
  });

  it("replaces a server of the same name, with the agent's own commands", async () => {
    const ran: string[][] = [];
    const command = serveCommand("agent-1");

    await register(
      "claude",
      "sanctum-office",
      command,
      async (each) => {
        ran.push(each);
      },
      ["node", "old"],
    );

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

  it("restores a Claude registration if its replacement fails", async () => {
    const ran: string[][] = [];
    await expect(
      register(
        "claude",
        "sanctum-office",
        ["node", "new"],
        async (command) => {
          ran.push(command);
          if (command.at(-1) === "new") throw new Error("Couldn't add server");
        },
        ["node", "old"],
      ),
    ).rejects.toThrow("Couldn't add server");
    expect(ran.map((command) => command.at(-1))).toEqual([
      "sanctum-office",
      "new",
      "old",
    ]);
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
      shown(
        ["claude", "mcp", "add", "sanctum", "--", "/Program Files/node"],
        "linux",
      ),
    ).toBe("claude mcp add sanctum -- '/Program Files/node'");
  });

  it.each(["claude", "codex"] as const)(
    "passes the store override to %s",
    (agent) => {
      const { add } = registration(
        agent,
        "sanctum",
        ["node", "serve"],
        "/a custom/store",
      );
      expect(add.slice(-5)).toEqual([
        "--env",
        "SANCTUM_MCP_DIR=/a custom/store",
        "--",
        "node",
        "serve",
      ]);
    },
  );
});
