import type { ActivityPage } from "@meetsanctum/app-sdk";
import { liveInvalidTokenCode } from "@meetsanctum/auth-protocol";
import { eq, inArray } from "drizzle-orm";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";

import type { AddedBy } from "../src/auth/clients.js";
import { registerAuth } from "../src/auth/routes.js";
import { authClients, authTokens } from "../src/auth/schema.js";
import { personWithClient } from "./devices-support.js";
import {
  claimed,
  get,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";
import { samplePackage } from "./workflows-support.js";

// AI agents: clients someone adds, whose token opens the MCP endpoint and
// nothing else, which act on behalf of whoever added them, do the everyday
// things only, and go with whoever added them.

async function household() {
  const core = await testCore();
  const maya = await claimed(core);
  return { core, maya };
}

function addAgent(core: TestCore, addedBy: AddedBy) {
  return core.auth.clients.createAgent({
    name: "Codex on the office Mac",
    platform: "macos",
    addedBy,
  });
}

function lastSeen(core: TestCore, id: string) {
  return core.db
    .select({ at: authClients.lastSeenAt })
    .from(authClients)
    .where(eq(authClients.id, id))
    .get()?.at;
}

describe("an agent's token", () => {
  it("is refused on other authenticated routes without marking the agent seen", async () => {
    const { core, maya } = await household();
    const { token, client } = addAgent(core, {
      kind: "person",
      id: maya.person.id,
    });

    for (const [method, url] of [
      ["get", "/api/auth/me"],
      ["get", "/api/auth/clients"],
      ["get", "/api/places"],
      ["get", "/api/activity"],
      ["post", "/api/pages/ticket"],
      ["post", "/api/devices/lights"],
    ] as const) {
      const response =
        method === "get"
          ? await get(core, url, { token })
          : await post(core, url, {}, { token });
      expect(response.statusCode, url).toBe(403);
      expect(response.json()).toEqual({ error: "forbidden" });
    }
    expect(lastSeen(core, client.id)).toBeNull();
  });

  it("admits the agent and marks it seen on the MCP route", async () => {
    const { core, maya } = await household();
    const { token, client } = addAgent(core, {
      kind: "person",
      id: maya.person.id,
    });
    const server = Fastify();
    onTestFinished(() => server.close());
    await registerAuth(server, { auth: core.auth, people: core.people });
    server.post("/api/mcp", async (request) => request.principal?.client.id);

    const response = await server.inject({
      method: "POST",
      url: "/api/mcp?session=test",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(client.id);
    expect(lastSeen(core, client.id)).toEqual(core.now());
  });

  it("can't open a live connection", async () => {
    const { core, maya } = await household();
    const { token, client } = addAgent(core, {
      kind: "person",
      id: maya.person.id,
    });

    await core.server.ready();
    const socket = await core.server.injectWS("/api/live");
    const closed = new Promise<number>((resolve) =>
      socket.on("close", (code) => resolve(code)),
    );
    socket.send(JSON.stringify({ type: "auth", token }));

    expect(await closed).toBe(liveInvalidTokenCode);
    expect(lastSeen(core, client.id)).toBeNull();
  });

  it("is refused once the agent is removed", async () => {
    const { core, maya } = await household();
    const { token, client } = addAgent(core, {
      kind: "person",
      id: maya.person.id,
    });

    const removed = await post(
      core,
      "/api/auth/clients/revoke",
      { id: client.id },
      maya,
    );

    expect(removed.statusCode).toBe(204);
    expect(core.auth.clients.authenticate(token)).toBeUndefined();
  });
});

describe("an agent", () => {
  it("acts as itself on behalf of whoever added it", async () => {
    const { core, maya } = await household();
    const { token, client } = addAgent(core, {
      kind: "person",
      id: maya.person.id,
    });

    const principal = core.auth.clients.authenticate(token)!;

    expect(principal.scope).toBe("agent");
    expect(principal.person).toBeUndefined();
    expect(core.gate.admit(principal, { tier: "write" })).toEqual({
      kind: "assistant-run",
      id: client.id,
      onBehalfOf: maya.person.id,
    });
  });

  it("does the everyday things only", async () => {
    const { core, maya } = await household();
    const { token } = addAgent(core, { kind: "person", id: maya.person.id });
    const principal = core.auth.clients.authenticate(token)!;

    expect(() => core.gate.admit(principal, { tier: "read" })).not.toThrow();
    for (const tier of ["destructive", "irreversible-external"] as const) {
      expect(() => core.gate.admit(principal, { tier })).toThrow(
        expect.objectContaining({ code: "needs_approval" }),
      );
    }
    // The same cap holds for what it sends on, as a device command does.
    expect(() =>
      core.gate.permit(
        {
          kind: "assistant-run",
          id: "agent",
          onBehalfOf: maya.person.id,
        },
        { tier: "destructive" },
      ),
    ).toThrow(expect.objectContaining({ code: "needs_approval" }));
  });

  it("isn't listed among the clients", async () => {
    const { core, maya } = await household();
    addAgent(core, { kind: "person", id: maya.person.id });

    const listed = await get(core, "/api/auth/clients", maya);

    expect(
      listed.json().map((client: { kind: string }) => client.kind),
    ).not.toContain("agent");
  });

  it("goes with the person who added it", async () => {
    const { core, maya } = await household();
    const ben = personWithClient(core);
    const { token } = addAgent(core, { kind: "person", id: ben.person.id });

    const removed = await post(
      core,
      "/api/people/remove",
      { id: ben.person.id },
      maya,
    );

    expect(removed.statusCode).toBe(204);
    expect(core.auth.clients.authenticate(token)).toBeUndefined();
  });

  it("goes with the shared device that added it", async () => {
    const { core, maya } = await household();
    const kitchen = sharedClient(core);
    const { token, client } = addAgent(core, {
      kind: "client",
      id: kitchen.id,
    });
    const other = addAgent(core, { kind: "person", id: maya.person.id });

    const revoked = await post(
      core,
      "/api/auth/clients/revoke",
      { id: kitchen.id },
      maya,
    );

    expect(revoked.statusCode).toBe(204);
    expect(core.auth.clients.authenticate(token)).toBeUndefined();
    expect(core.auth.clients.authenticate(other.token)).toBeDefined();
    const revokedTokens = core.db
      .select({ at: authTokens.revokedAt })
      .from(authTokens)
      .where(inArray(authTokens.clientId, [kitchen.id, client.id]))
      .all();
    expect(revokedTokens).toEqual([{ at: core.now() }, { at: core.now() }]);
  });

  it("requires an active shared device as a client adder", async () => {
    const { core, maya } = await household();
    const tablet = sharedClient(core);
    const { client: agent } = addAgent(core, {
      kind: "person",
      id: maya.person.id,
    });
    await post(core, "/api/auth/clients/revoke", { id: tablet.id }, maya);

    for (const id of [maya.client.id, agent.id, tablet.id]) {
      expect(() => addAgent(core, { kind: "client", id })).toThrow(
        expect.objectContaining({ code: "forbidden" }),
      );
    }
  });

  it("has exactly one who added it, and no other client has one", async () => {
    const { core, maya } = await household();
    const row = {
      name: "Agent",
      platform: "macos" as const,
      createdAt: new Date(),
    };

    expect(() =>
      core.db
        .insert(authClients)
        .values({ id: randomUUID(), kind: "agent", ...row })
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      core.db
        .insert(authClients)
        .values({
          id: randomUUID(),
          kind: "shared",
          addedByPersonId: maya.person.id,
          addedByClientId: sharedClient(core).id,
          ...row,
        })
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      core.db
        .insert(authClients)
        .values({
          id: randomUUID(),
          kind: "shared",
          addedByPersonId: maya.person.id,
          ...row,
        })
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe("the activity log", () => {
  it("names an agent and who added it, after it's removed too", async () => {
    const { core, maya } = await household();
    const { client } = addAgent(core, {
      kind: "person",
      id: maya.person.id,
    });
    core.activity.for("devices")({
      action: "device.command",
      outcome: "ok",
      actor: `assistant-run:${client.id}`,
    });
    await post(core, "/api/auth/clients/revoke", { id: client.id }, maya);

    const [entry] = core.activity
      .page({ limit: 10 })
      .entries.filter((each) => each.action === "device.command");
    const who = core.activityViews.info(entry!).who;

    expect(who).toEqual({
      kind: "agent",
      id: client.id,
      name: "Codex on the office Mac",
      addedBy: { kind: "person", id: maya.person.id, name: "Maya" },
    });
  });

  it("keeps the agent and its adder on an app action after the adder leaves", async () => {
    const core = await testCore({ apps: [samplePackage] });
    const maya = await claimed(core);
    const ben = personWithClient(core);
    const { token, client } = addAgent(core, {
      kind: "person",
      id: ben.person.id,
    });

    await core.apps.call({
      principal: core.auth.clients.authenticate(token)!,
      appId: samplePackage.app.id,
      actionId: "sample.note",
      input: { text: "Tidy the office" },
    });
    await post(
      core,
      "/api/auth/clients/rename",
      { id: client.id, name: "Office agent" },
      maya,
    );
    const removed = await post(
      core,
      "/api/people/remove",
      { id: ben.person.id },
      maya,
    );
    expect(removed.statusCode).toBe(204);
    expect(core.auth.clients.authenticate(token)).toBeUndefined();

    const response = await get(core, "/api/activity", maya);
    const entry = response
      .json<ActivityPage>()
      .entries.find((each) => each.action === "sample.note");
    expect(entry?.who).toEqual({
      kind: "agent",
      id: client.id,
      name: "Codex on the office Mac",
      addedBy: { kind: "person", id: ben.person.id, name: "Ben" },
    });
  });
});
