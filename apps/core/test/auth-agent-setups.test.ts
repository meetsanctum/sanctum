import type { ActivityPage } from "@meetsanctum/app-sdk";
import {
  agentConnectorProtocols,
  parseAgentSetupCode,
  type AgentInfo,
  type AgentSetupStarted,
  type AgentSetupStatus,
  type AgentTokenCollected,
} from "@meetsanctum/auth-protocol";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { activity } from "../src/activity/schema.js";
import { createCoreCertificates } from "../src/certificate.js";
import { connect } from "./agents-support.js";
import { testCa } from "./certificates.js";
import {
  claimed,
  get,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// Adding an AI agent: someone starts a setup and pastes its code into the
// agent, whose connector trades the code's secret for the agent's token
// once. The setup says it connected only once the agent's first call with
// that token has come in.

const office = "192.168.7.20";
const protocol = agentConnectorProtocols.newest;

async function start(core: TestCore, token: string, name = "Codex") {
  const response = await post(
    core,
    "/api/auth/agents/setup",
    { name },
    { token },
  );
  expect(response.statusCode).toBe(200);
  const started = response.json<AgentSetupStarted>();
  const code = parseAgentSetupCode(started.code)!;
  expect(code).not.toBeNull();
  return { ...started, secret: code.secret, parsed: code };
}

function collect(
  core: TestCore,
  setup: { setupId: string; secret: string },
  {
    remoteAddress = office,
    ...rest
  }: { remoteAddress?: string; protocol?: number } = {},
) {
  return post(
    core,
    "/api/auth/agents/collect",
    {
      setupId: setup.setupId,
      secret: setup.secret,
      platform: "macos",
      protocol: rest.protocol ?? protocol,
    },
    { remoteAddress },
  );
}

async function status(core: TestCore, token: string, setupId: string) {
  const response = await get(core, `/api/auth/agents/setup/${setupId}`, {
    token,
  });
  expect(response.statusCode).toBe(200);
  return response.json<AgentSetupStatus>();
}

// The agent's first call: any request to the MCP endpoint with its token.
function firstCall(core: TestCore, token: string) {
  return post(core, "/api/mcp", {}, { token, remoteAddress: office });
}

async function agents(core: TestCore, token: string) {
  const response = await get(core, "/api/auth/agents", { token });
  expect(response.statusCode).toBe(200);
  return response.json<AgentInfo[]>();
}

function entries(core: TestCore, action: string) {
  return core.db
    .select()
    .from(activity)
    .where(eq(activity.action, action))
    .all();
}

const wrong = "w".repeat(43);

describe("adding an AI agent", () => {
  it("gives the connector the agent's token, and connects on its first call", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const setup = await start(core, maya.token, "Codex on the office Mac");

    expect(setup.parsed).toEqual({
      homeId: core.homeId,
      pin: null,
      url: "http://localhost:80",
      setupId: setup.setupId,
      secret: setup.secret,
    });
    expect(setup.expiresAt).toBe("2026-10-26T12:10:00.000Z");
    expect(await status(core, maya.token, setup.setupId)).toEqual({
      status: "waiting",
      name: "Codex on the office Mac",
      expiresAt: "2026-10-26T12:10:00.000Z",
    });

    const collected = await collect(core, setup);
    expect(collected.statusCode).toBe(200);
    const { token, agent } = collected.json<AgentTokenCollected>();
    expect(agent.name).toBe("Codex on the office Mac");
    // Collected, but the agent hasn't reached the home with it yet.
    expect((await status(core, maya.token, setup.setupId)).status).toBe(
      "waiting",
    );
    expect(await agents(core, maya.token)).toEqual([]);

    core.advance(30_000);
    expect((await firstCall(core, token)).statusCode).not.toBe(401);

    expect(await status(core, maya.token, setup.setupId)).toEqual({
      status: "connected",
      agent,
      address: office,
      connectedAt: "2026-10-26T12:00:30.000Z",
    });
    expect(await agents(core, maya.token)).toEqual([
      {
        id: agent.id,
        name: "Codex on the office Mac",
        platform: "macos",
        addedBy: { kind: "person", id: maya.person.id, name: "Maya" },
        createdAt: "2026-10-26T12:00:00.000Z",
        lastSeenAt: "2026-10-26T12:00:30.000Z",
      },
    ]);
    expect(entries(core, "agents.setup")).toMatchObject([
      { outcome: "ok", personId: maya.person.id, detail: { name: agent.name } },
    ]);
    expect(entries(core, "agents.add")).toMatchObject([
      {
        outcome: "ok",
        personId: maya.person.id,
        subjectId: agent.id,
        address: office,
      },
    ]);
    const page = (
      await get(core, "/api/activity", { token: maya.token })
    ).json<ActivityPage>();
    expect(
      page.entries.find((entry) => entry.action === "agents.add")?.subject,
    ).toEqual({
      type: "client",
      id: agent.id,
      name: "Codex on the office Mac",
      gone: false,
    });

    core.advance(60_000);
    const client = await connect(core, token);
    await client.listTools();
    expect(await agents(core, maya.token)).toMatchObject([
      { lastSeenAt: "2026-10-26T12:01:30.000Z" },
    ]);
    expect(await status(core, maya.token, setup.setupId)).toMatchObject({
      connectedAt: "2026-10-26T12:00:30.000Z",
    });
  });

  it("carries the pin of the host CA the core serves", async () => {
    const certificates = createCoreCertificates({
      sign: (await testCa()).sign,
      log: () => undefined,
    });
    const { pin } = await certificates.first();
    const core = await testCore({ certificates });
    const maya = await claimed(core);

    expect((await start(core, maya.token)).parsed.pin).toBe(pin);
  });

  it("is added by a shared device as the device", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const tablet = sharedClient(core);
    const setup = await start(core, tablet.token);

    const { token } = (await collect(core, setup)).json<AgentTokenCollected>();
    await firstCall(core, token);

    expect((await agents(core, maya.token))[0]?.addedBy).toEqual({
      kind: "client",
      id: tablet.id,
      name: "Kitchen tablet",
    });
  });

  it("can't be started with an agent's token", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const setup = await start(core, maya.token);
    const { token } = (await collect(core, setup)).json<AgentTokenCollected>();

    const response = await post(
      core,
      "/api/auth/agents/setup",
      { name: "Another" },
      { token },
    );
    expect(response.statusCode).toBe(403);
    expect((await get(core, "/api/auth/agents", { token })).statusCode).toBe(
      403,
    );
  });

  it("hands its token out once", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const setup = await start(core, maya.token);

    expect((await collect(core, setup)).statusCode).toBe(200);
    const again = await collect(core, setup);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "expired" });
  });

  it("keeps a collected setup's state when its code is entered incorrectly", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const setup = await start(core, maya.token);
    const { token } = (await collect(core, setup)).json<AgentTokenCollected>();

    for (let tries = 0; tries < 5; tries += 1) {
      expect((await collect(core, { ...setup, secret: wrong })).json()).toEqual(
        {
          error: "expired",
        },
      );
    }
    expect((await status(core, maya.token, setup.setupId)).status).toBe(
      "waiting",
    );
    expect(
      entries(core, "agents.add").filter(
        (entry) => entry.reason === "wrong_secret",
      ),
    ).toHaveLength(5);

    await post(
      core,
      "/api/auth/agents/setup/cancel",
      { setupId: setup.setupId },
      { token: maya.token },
    );
    expect((await firstCall(core, token)).statusCode).toBe(401);
  });

  it("fails after too many wrong secrets, and logs them", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const setup = await start(core, maya.token);

    for (let tries = 0; tries < 5; tries += 1) {
      const response = await collect(core, { ...setup, secret: wrong });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "expired" });
    }

    expect((await collect(core, setup)).statusCode).toBe(409);
    expect((await status(core, maya.token, setup.setupId)).status).toBe(
      "failed",
    );
    expect(
      entries(core, "agents.add").filter(
        (entry) => entry.reason === "wrong_secret",
      ),
    ).toHaveLength(5);
  });

  it("answers a setup it doesn't have as one that ran out", async () => {
    const core = await testCore();
    await claimed(core);

    const response = await collect(core, {
      setupId: "8b0d3c1e-0000-4000-8000-000000000000",
      secret: wrong,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "expired" });
  });

  it("holds back an address that keeps sending wrong secrets", async () => {
    const core = await testCore({ limits: { attempts: 3 } });
    const maya = await claimed(core);
    const setups = [
      await start(core, maya.token),
      await start(core, maya.token),
    ];

    for (const setup of [setups[0]!, setups[0]!, setups[1]!]) {
      await collect(core, { ...setup, secret: wrong });
    }
    const held = await collect(core, setups[1]!);
    expect(held.statusCode).toBe(429);
    expect(held.json()).toEqual({ error: "too_many_attempts" });
    expect(
      entries(core, "agents.add").filter(
        (entry) => entry.reason === "too_many_attempts",
      ),
    ).toHaveLength(1);

    // Another computer, and the household's own sign-ins, aren't held.
    expect(
      (await collect(core, setups[1]!, { remoteAddress: "192.168.7.21" }))
        .statusCode,
    ).toBe(200);
  });

  it("caps the setups waiting at once", async () => {
    const core = await testCore({ limits: { agentSetupsOpen: 2 } });
    const maya = await claimed(core);
    const setup = await start(core, maya.token);
    await start(core, maya.token);
    const { token } = (await collect(core, setup)).json<AgentTokenCollected>();

    const third = await post(
      core,
      "/api/auth/agents/setup",
      { name: "Codex" },
      { token: maya.token },
    );
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: "busy" });

    // A setup that connects makes room.
    await firstCall(core, token);
    expect((await start(core, maya.token)).setupId).toBeTruthy();
  });

  it("runs out, and takes back a token its agent never used", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const unused = await start(core, maya.token);
    const collectedOnly = await start(core, maya.token);
    const { token } = (
      await collect(core, collectedOnly)
    ).json<AgentTokenCollected>();

    core.advance(10 * 60_000);

    // The deadline applies even if nobody has checked the setup since.
    expect((await firstCall(core, token)).statusCode).toBe(401);
    expect((await collect(core, unused)).statusCode).toBe(409);
    expect(await status(core, maya.token, unused.setupId)).toEqual({
      status: "expired",
      name: "Codex",
    });
    expect((await status(core, maya.token, collectedOnly.setupId)).status).toBe(
      "expired",
    );
    expect(await agents(core, maya.token)).toEqual([]);
  });

  it("is cancelled from the sheet, with any token it gave out", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const waiting = await start(core, maya.token);
    const collectedOnly = await start(core, maya.token);
    const { token } = (
      await collect(core, collectedOnly)
    ).json<AgentTokenCollected>();

    for (const setup of [waiting, collectedOnly]) {
      const response = await post(
        core,
        "/api/auth/agents/setup/cancel",
        { setupId: setup.setupId },
        { token: maya.token },
      );
      expect(response.statusCode).toBe(204);
      expect((await status(core, maya.token, setup.setupId)).status).toBe(
        "cancelled",
      );
    }
    expect((await collect(core, waiting)).statusCode).toBe(409);
    expect((await firstCall(core, token)).statusCode).toBe(401);
    expect(entries(core, "agents.setup-cancel")).toHaveLength(2);
  });

  it("leaves an agent that connected when its setup is cancelled", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const setup = await start(core, maya.token);
    const { token } = (await collect(core, setup)).json<AgentTokenCollected>();
    await firstCall(core, token);

    await post(
      core,
      "/api/auth/agents/setup/cancel",
      { setupId: setup.setupId },
      { token: maya.token },
    );

    expect((await status(core, maya.token, setup.setupId)).status).toBe(
      "connected",
    );
    expect(await agents(core, maya.token)).toHaveLength(1);
    // Ten minutes on, it stays: it connected.
    core.advance(10 * 60_000);
    expect(await agents(core, maya.token)).toHaveLength(1);
  });

  it("says when removing the agent took it away", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const setup = await start(core, maya.token);
    const { token, agent } = (
      await collect(core, setup)
    ).json<AgentTokenCollected>();
    await firstCall(core, token);
    core.advance(10 * 60_000);

    await post(
      core,
      "/api/auth/clients/revoke",
      { id: agent.id },
      { token: maya.token },
    );

    expect((await status(core, maya.token, setup.setupId)).status).toBe(
      "cancelled",
    );
    expect(await agents(core, maya.token)).toEqual([]);
  });

  it("tells a connector the home can't work with what to update", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const setup = await start(core, maya.token);

    const tooNew = await collect(core, setup, {
      protocol: agentConnectorProtocols.newest + 1,
    });
    expect(tooNew.statusCode).toBe(409);
    expect(tooNew.json()).toEqual({ error: "connector_too_new" });
    const newer = await collect(core, setup, { protocol: 1_001 });
    expect(newer.statusCode).toBe(409);
    expect(newer.json()).toEqual({ error: "connector_too_new" });
    const tooOld = await collect(core, setup, {
      protocol: agentConnectorProtocols.oldest - 1,
    });
    expect(tooOld.json()).toEqual({ error: "connector_too_old" });

    // Neither used the setup up.
    expect((await collect(core, setup)).statusCode).toBe(200);
  });

  it("can't be collected once whoever started it has left", async () => {
    const core = await testCore({ limits: { agentSetupsOpen: 1 } });
    const maya = await claimed(core);
    const tablet = sharedClient(core);
    const setup = await start(core, tablet.token);

    await post(
      core,
      "/api/auth/clients/revoke",
      { id: tablet.id },
      { token: maya.token },
    );

    expect((await collect(core, setup)).statusCode).toBe(409);
    expect((await status(core, maya.token, setup.setupId)).status).toBe(
      "cancelled",
    );
    expect((await start(core, maya.token)).setupId).toBeTruthy();
  });
});
