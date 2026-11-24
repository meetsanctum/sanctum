import type { ActivityPage } from "@meetsanctum/app-sdk";
import { liveInvalidTokenCode } from "@meetsanctum/auth-protocol";
import { eq, inArray } from "drizzle-orm";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";

import { agentOf } from "../src/app-host/gate.js";
import type { AddedBy } from "../src/auth/clients.js";
import { registerAuth } from "../src/auth/routes.js";
import { authClients, authTokens } from "../src/auth/schema.js";
import { apart, running, useCleanUps } from "./app-apart-support.js";
import { lampsCore, personWithClient, radio } from "./devices-support.js";
import {
  claimed,
  get,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";
import { samplePackage } from "./workflows-support.js";

useCleanUps();

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
    server.post(
      "/api/mcp",
      { config: { agent: true } },
      async (request) => request.principal?.client.id,
    );

    const response = await server.inject({
      method: "POST",
      url: "/api/mcp?session=test",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(client.id);
    expect(lastSeen(core, client.id)).toEqual(core.now());
    // Only the MCP route itself, however its path is dressed.
    for (const url of [
      "/api/mcp/",
      "/api/mcp/x",
      "/API/MCP",
      "//api/mcp",
      "/api/mcp%2f..%2fauth%2fme",
      "/api/places?/api/mcp",
    ]) {
      const other = await server.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(other.statusCode, url).toBe(403);
    }
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
    const { token, client } = addAgent(core, {
      kind: "person",
      id: maya.person.id,
    });
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
          id: client.id,
          onBehalfOf: maya.person.id,
        },
        { tier: "destructive" },
      ),
    ).toThrow(expect.objectContaining({ code: "needs_approval" }));
  });

  it("is refused new calls and what it sends on once it's removed", async () => {
    const { core, maya } = await household();
    const { token, client } = addAgent(core, {
      kind: "person",
      id: maya.person.id,
    });
    const principal = core.auth.clients.authenticate(token);
    if (principal?.scope !== "agent") {
      throw new Error("Expected an agent principal");
    }
    const caller = agentOf(principal);
    // An agent's principal and the agent built from it run as the same actor.
    expect(core.gate.admit(principal, { tier: "write" })).toEqual(caller.actor);
    const actor = core.gate.admit(caller, { tier: "write" });

    await post(core, "/api/auth/clients/revoke", { id: client.id }, maya);

    expect(() => core.gate.admit(caller, { tier: "write" })).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => core.gate.permit(actor, { tier: "write" })).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
  });

  it("cannot start an app action that waited for the app to come back", async () => {
    const app = samplePackage.app;
    const { core, session, reconnect } = await apart(app);
    await claimed(core);
    const ben = personWithClient(core);
    const { token, client } = addAgent(core, {
      kind: "person",
      id: ben.person.id,
    });
    await running(core, app.id);
    await session.shutdown(100);
    await expect.poll(() => core.apps.isRunning(app.id)).toBe(false);

    const call = core.apps.call({
      caller: core.auth.clients.authenticate(token)!,
      appId: app.id,
      actionId: "sample.note",
      input: { text: "Tidy the office" },
    });
    const result = call.catch((error: unknown) => error);
    core.people.remove(ben.person.id);
    reconnect();
    await running(core, app.id);

    expect(await result).toMatchObject({ code: "forbidden" });
    const entry = core.activity
      .recent()
      .find((each) => each.action === "sample.note")!;
    expect(entry).toMatchObject({ outcome: "refused", reason: "forbidden" });
    expect(core.activityViews.info(entry).who).toEqual({
      kind: "agent",
      id: client.id,
      name: client.name,
      addedBy: { kind: "person", id: ben.person.id, name: ben.person.name },
    });
  });

  it("does not resend an unconfirmed device command after revocation", async () => {
    const { core, maya, plug } = await lampsCore({ confirmMs: 250 });
    radio.confirms = false;
    core.agentsCanUse.setArea("devices.control:switch", true, {
      clientId: maya.client.id,
    });
    const { token, client } = addAgent(core, {
      kind: "person",
      id: maya.person.id,
    });
    const actor = core.gate.admit(core.auth.clients.authenticate(token)!, {
      tier: "write",
    });

    await core.devices.command(
      actor,
      { device: plug, capability: "power", command: { on: true } },
      {},
      null,
    );
    core.auth.clients.revoke(core.auth.clients.authenticate(maya.token)!, {
      id: client.id,
    });

    const entry = () =>
      core.activity.recent().find((each) => each.action === "device.command");
    await expect
      .poll(entry)
      .toMatchObject({ outcome: "failed", reason: "forbidden" });
    expect(radio.received).toHaveLength(1);
    expect(entry()?.detail?.resent).toBeUndefined();
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
    // The log says each went: the shared device, and the agent with it.
    const gone = core.activity
      .page({ limit: 20 })
      .entries.filter((entry) => entry.action === "client.revoke")
      .map((entry) => entry.subjectId);
    expect(gone.sort()).toEqual([client.id, kitchen.id].sort());
  });

  it("is revoked on restore without being counted as a signed-out device", async () => {
    const { core, maya } = await household();
    const { token } = addAgent(core, { kind: "person", id: maya.person.id });

    const signedOut = core.db.transaction(() =>
      core.auth.signOutEveryone(core.now()),
    );

    expect(signedOut).toBe(1);
    expect(core.auth.clients.authenticate(token)).toBeUndefined();
    expect(core.auth.clients.authenticate(maya.token)).toBeUndefined();
  });

  it("requires someone in the household as a person adder", async () => {
    const { core } = await household();

    expect(() =>
      addAgent(core, { kind: "person", id: "someone-who-isnt-here" }),
    ).toThrow(expect.objectContaining({ code: "forbidden" }));
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
      ...core.activity.agentWho(client.id),
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
    const removal = core.activity
      .recent()
      .find((each) => each.action === "client.revoke");
    expect(removal?.detail).toEqual({ kind: "agent", name: client.name });
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
      caller: core.auth.clients.authenticate(token)!,
      appId: samplePackage.app.id,
      actionId: "sample.note",
      input: { text: "Tidy the office" },
    });
    await core.apps.call({
      caller: core.auth.clients.authenticate(token)!,
      appId: samplePackage.app.id,
      actionId: "sample.note",
      input: { text: "Water the plants" },
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
    const entries = response
      .json<ActivityPage>()
      .entries.filter((each) => each.action === "sample.note");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.who).toEqual({
      kind: "agent",
      id: client.id,
      name: "Codex on the office Mac",
      addedBy: { kind: "person", id: ben.person.id, name: "Ben" },
    });
  });

  it("names who added the agent as they're named now", async () => {
    const { core, maya } = await household();
    const ben = personWithClient(core);
    const { client } = addAgent(core, { kind: "person", id: ben.person.id });
    core.activity.for("devices")({
      action: "device.command",
      outcome: "ok",
      ...core.activity.agentWho(client.id),
    });

    await post(
      core,
      "/api/people/update",
      { id: ben.person.id, name: "Benjamin" },
      maya,
    );

    const [entry] = core.activity
      .page({ limit: 10 })
      .entries.filter((each) => each.action === "device.command");
    expect(core.activityViews.info(entry!).who).toMatchObject({
      kind: "agent",
      addedBy: { kind: "person", id: ben.person.id, name: "Benjamin" },
    });
  });
});
