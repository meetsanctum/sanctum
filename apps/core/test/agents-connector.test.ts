import {
  agentSetupCodeText,
  parseAgentSetupCode,
  type AgentSetupStarted,
  type AgentSetupStatus,
} from "@meetsanctum/auth-protocol";
import {
  connect,
  connectedWords,
  ConnectError,
  connectorServer,
  connectWords,
  fileTokens,
  homeLink,
  loadConnection,
  saveConnection,
  words,
  type ConnectOptions,
} from "@meetsanctum/mcp";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createCoreCertificates } from "../src/certificate.js";
import { testCa } from "./certificates.js";
import { claimed, get, post, testCore, type TestCore } from "./support.js";

// The AI agents' connector, @meetsanctum/mcp, against a real core over
// HTTPS: adding an agent with a setup's code, then the agent's MCP server
// passing its calls on, for agents on either revision of the protocol.

async function homeOverHttps() {
  const certificates = createCoreCertificates({
    sign: (await testCa()).sign,
    log: () => undefined,
  });
  await certificates.first();
  const core = await testCore({ certificates });
  const maya = await claimed(core);
  await core.server.listen({ host: "127.0.0.1", port: 0 });
  const { port } = core.server.server.address() as { port: number };
  return { core, maya, url: `https://127.0.0.1:${port}` };
}

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "sanctum-connector-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startSetup(core: TestCore, token: string) {
  const response = await post(
    core,
    "/api/auth/agents/setup",
    { name: "Claude Code on the office Mac" },
    { token },
  );
  return response.json<AgentSetupStarted>();
}

async function status(core: TestCore, token: string, setupId: string) {
  return (
    await get(core, `/api/auth/agents/setup/${setupId}`, { token })
  ).json<AgentSetupStatus>();
}

async function options(
  url: string,
): Promise<ConnectOptions & { ran: string[][] }> {
  const dir = await folder();
  const ran: string[][] = [];
  return {
    dir,
    tokens: fileTokens(dir),
    agent: "claude",
    platform: "macos",
    // The code's address is the one the test reached the core at, which
    // isn't the port the core listens on: discovery finds it.
    discover: async () => [url],
    run: async (command) => {
      ran.push(command);
    },
    ran,
  };
}

// An agent's MCP client on the connector's server, as the agent starts it.
async function agentOn(
  link: ReturnType<typeof homeLink>,
  revision: "2025-11-25" | "2026-07-28",
) {
  const [agentSide, connectorSide] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(() => connectorServer(link), {
    legacy: "serve",
    transport: connectorSide,
  });
  onTestFinished(() => served.close());
  const client = new Client(
    { name: "agent", version: "0.0.0" },
    {
      versionNegotiation: {
        mode: revision === "2026-07-28" ? { pin: revision } : "legacy",
      },
    },
  );
  await client.connect(agentSide);
  return client;
}

describe("the AI agents' connector", () => {
  it("adds an agent with a setup's code, and passes its calls on", async () => {
    const { core, maya, url } = await homeOverHttps();
    const setup = await startSetup(core, maya.token);
    const connecting = await options(url);

    const connected = await connect(setup.code, connecting);

    const { connection } = connected;
    expect(connection).toMatchObject({
      name: "sanctum-home",
      agent: "claude",
      homeId: core.homeId,
      url,
      anchor: { pin: parseAgentSetupCode(setup.code)!.pin },
    });
    expect(await loadConnection(connecting.dir, connection.clientId)).toEqual(
      connection,
    );
    expect(await connecting.tokens.get(connection.clientId)).toMatch(
      /^client_/,
    );
    // Its first call has been made, so the sheet says it connected.
    expect(await status(core, maya.token, setup.setupId)).toMatchObject({
      status: "connected",
      agent: { id: connection.clientId },
    });
    expect(connecting.ran).toEqual([
      ["claude", "mcp", "remove", "--scope", "user", "sanctum-home"],
      [
        "claude",
        "mcp",
        "add",
        "--scope",
        "user",
        "sanctum-home",
        "--",
        "npx",
        "-y",
        "@meetsanctum/mcp@0.1.0",
        "serve",
        "--connection",
        connection.clientId,
      ],
    ]);
    expect(connectedWords(connected, connecting.tokens)).toContain(
      "Connected to Home as the MCP server “sanctum-home”.",
    );

    const link = homeLink({
      dir: connecting.dir,
      clientId: connection.clientId,
      tokens: connecting.tokens,
      discover: async () => [],
    });
    for (const revision of ["2025-11-25", "2026-07-28"] as const) {
      const agent = await agentOn(link, revision);
      const { tools } = await agent.listTools();
      expect(
        tools.map((tool) => tool.name),
        revision,
      ).toContain("home_overview");
      const overview = await agent.callTool({ name: "home_overview" });
      expect(overview.isError, revision).toBeFalsy();
      expect(overview.structuredContent, revision).toMatchObject({
        home: { name: "Home" },
        agent: { name: "Claude Code on the office Mac" },
      });
    }
  });

  it("sends nothing to a computer that isn't the home", async () => {
    const { core, maya, url } = await homeOverHttps();
    const setup = await startSetup(core, maya.token);
    const code = parseAgentSetupCode(setup.code)!;
    // The same setup, with another home's pin.
    const forged = agentSetupCodeText({ ...code, pin: "A".repeat(43) });

    await expect(connect(forged, await options(url))).rejects.toThrow(
      new ConnectError(connectWords.notThisHome),
    );
    expect(await status(core, maya.token, setup.setupId)).toMatchObject({
      status: "waiting",
    });
  });

  it("says when the setup has run out", async () => {
    const { core, maya, url } = await homeOverHttps();
    const setup = await startSetup(core, maya.token);
    core.advance(10 * 60_000);

    await expect(connect(setup.code, await options(url))).rejects.toThrow(
      connectWords.expired,
    );
    await expect(
      connect("sanctum:nonsense", await options(url)),
    ).rejects.toThrow(connectWords.notACode);
  });

  it("finds the home again where it moved, and forgets a removed agent", async () => {
    const { core, maya, url } = await homeOverHttps();
    const setup = await startSetup(core, maya.token);
    const connecting = await options(url);
    const { connection } = await connect(setup.code, connecting);
    // It answered elsewhere before; discovery finds where it is now.
    await saveConnection(connecting.dir, {
      ...connection,
      url: "https://127.0.0.1:1",
    });
    const link = homeLink({
      dir: connecting.dir,
      clientId: connection.clientId,
      tokens: connecting.tokens,
      discover: async () => [url],
    });
    const agent = await agentOn(link, "2026-07-28");

    expect(
      (await agent.callTool({ name: "home_overview" })).isError,
    ).toBeFalsy();
    expect(
      (await loadConnection(connecting.dir, connection.clientId))?.url,
    ).toBe(url);

    await post(
      core,
      "/api/auth/clients/revoke",
      { id: connection.clientId },
      { token: maya.token },
    );
    const refused = await agent.callTool({ name: "home_overview" });
    expect(refused).toMatchObject({
      isError: true,
      content: [{ type: "text", text: words.removed }],
    });
    expect(await connecting.tokens.get(connection.clientId)).toBeUndefined();
    expect(
      await loadConnection(connecting.dir, connection.clientId),
    ).toBeUndefined();
  });
});
