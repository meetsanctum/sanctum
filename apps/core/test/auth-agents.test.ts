import { liveInvalidTokenCode } from "@meetsanctum/auth-protocol";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { authClients } from "../src/auth/schema.js";
import { personWithClient } from "./devices-support.js";
import {
  claimed,
  get,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// AI agents: clients someone adds, whose token opens the MCP endpoint and
// nothing else, which act on behalf of whoever added them, do the everyday
// things only, and go with whoever added them.

async function household() {
  const core = await testCore();
  const maya = await claimed(core);
  return { core, maya };
}

function addAgent(
  core: TestCore,
  addedBy: { kind: "person" | "client"; id: string },
) {
  return core.auth.clients.createAgent({
    name: "Codex on the office Mac",
    platform: "macos",
    addedBy,
  });
}

describe("an agent's token", () => {
  it("is refused everywhere but the MCP endpoint", async () => {
    const { core, maya } = await household();
    const { token } = addAgent(core, { kind: "person", id: maya.person.id });

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
    // Admitted to the MCP endpoint's path, wherever its route is not.
    const mcp = await post(core, "/api/mcp", {}, { token });
    expect([401, 403]).not.toContain(mcp.statusCode);
  });

  it("can't open a live connection", async () => {
    const { core, maya } = await household();
    const { token } = addAgent(core, { kind: "person", id: maya.person.id });

    await core.server.ready();
    const socket = await core.server.injectWS("/api/live");
    const closed = new Promise<number>((resolve) =>
      socket.on("close", (code) => resolve(code)),
    );
    socket.send(JSON.stringify({ type: "auth", token }));

    expect(await closed).toBe(liveInvalidTokenCode);
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
    const { token } = addAgent(core, { kind: "client", id: kitchen.id });
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
});
