import { defineAction, defineApp } from "@meetsanctum/app-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AppPackage, Origin } from "../src/app-host/host.js";
import { ManagerRefusal } from "../src/manager.js";
import {
  claimed,
  fakeManager,
  managerSocket,
  post,
  testCore,
  type TestCore,
} from "./support.js";

// Services the manager runs for apps: requested over the manager's socket
// when an app that declares one starts, released when it is removed, and
// handed to the app through its context.

const zigbeeConnection = {
  mqtt: {
    url: "mqtt://sanctum-mosquitto:1883",
    username: "test.bridge",
    password: "from-the-socket",
    topics: ["zigbee2mqtt/#"],
  },
  baseTopic: "zigbee2mqtt",
};

// A driver-like app that asks for its broker account in an action.
function bridge(
  options: { origin?: Origin; id?: string; permissions?: string[] } = {},
): AppPackage {
  const id = options.id ?? "test.bridge";
  return {
    origin: options.origin ?? "official",
    app: defineApp({
      id,
      name: "Bridge",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: (options.permissions ?? ["services:zigbee2mqtt"]).map(
        (id) => ({ id, reason: "For the test." }),
      ),
      events: [],
      actions: [
        defineAction({
          id: "bridge.account",
          title: "Broker account",
          tier: "read",
          input: z.object({}),
          output: z.object({ username: z.string(), baseTopic: z.unknown() }),
          async run(ctx) {
            const connection = await ctx.services.connection("zigbee2mqtt");
            return {
              username: connection.mqtt?.username ?? "",
              baseTopic: connection.baseTopic,
            };
          },
        }),
      ],
    }),
  };
}

async function account(core: TestCore, appId = "test.bridge") {
  const { token } = await claimed(core);
  return post(core, `/api/apps/${appId}/actions/bridge.account`, {}, { token });
}

// What it asked for, leaving out reading what the manager keeps for it.
const asked = (socket: { received: { method: string }[] }) =>
  socket.received.filter(({ method }) => method !== "GET");

// The manager's socket, answering for services as `answer` says, with no app's
// update under way, which an app reads before it starts.
const servicesSocket = (answer: Parameters<typeof managerSocket>[0]) =>
  managerSocket((request) =>
    request.url === "/api/apps/updates"
      ? { status: 200, body: { updates: {} } }
      : answer(request),
  );

describe("what a version left behind", () => {
  it("releases a service the app no longer declares, as a failed version's", async () => {
    const { manager, calls, kept } = fakeManager();
    kept.set("test.bridge", ["zigbee2mqtt", "matter"]);

    await testCore({ apps: [bridge()], manager });

    await vi.waitFor(() =>
      expect(calls).toContain("DELETE matter test.bridge"),
    );
    expect(calls).not.toContain("DELETE zigbee2mqtt test.bridge");
  });

  it("releases nothing while it holds only what it declares", async () => {
    const { manager, calls, kept } = fakeManager();
    kept.set("test.bridge", ["zigbee2mqtt"]);

    await testCore({ apps: [bridge()], manager });
    await new Promise((done) => setTimeout(done, 10));

    expect(calls.filter((each) => each.startsWith("DELETE"))).toEqual([]);
  });

  it("ignores an old service lookup after the app is installed again", async () => {
    const { manager, calls } = fakeManager();
    let answer!: (names: string[]) => void;
    const oldLookup = new Promise<string[]>((resolve) => (answer = resolve));
    manager.servicesHeldBy = vi
      .fn()
      .mockImplementationOnce(() => oldLookup)
      .mockResolvedValue(["zigbee2mqtt"]);
    const core = await testCore({
      apps: [bridge({ permissions: [] })],
      manager,
    });

    await core.apps.remove("test.bridge");
    const next = bridge();
    await core.startApps([
      {
        ...next,
        app: {
          ...next.app,
          permissions: [
            {
              id: "services:zigbee2mqtt",
              reason: "For the test.",
              needed: true,
            },
          ],
        },
      },
    ]);
    expect(calls).toEqual(["PUT zigbee2mqtt test.bridge"]);

    answer(["zigbee2mqtt"]);
    await oldLookup;

    expect(calls).toEqual(["PUT zigbee2mqtt test.bridge"]);
  });

  it("starts as usual when the manager can't say what it holds", async () => {
    const { manager, calls } = fakeManager();
    manager.servicesHeldBy = async () => {
      throw new Error("The manager did not answer");
    };

    const core = await testCore({ apps: [bridge()], manager });

    await vi.waitFor(() =>
      expect(core.logs.join()).toContain(
        "could not read which services test.bridge holds",
      ),
    );
    expect(calls).toContain("PUT zigbee2mqtt test.bridge");
  });
});

describe("an app's services", () => {
  it("are requested from the manager over its socket, and reach the app", async () => {
    const socket = await servicesSocket(() => ({
      status: 200,
      body: { service: { name: "zigbee2mqtt" }, connection: zigbeeConnection },
    }));
    const core = await testCore({ apps: [bridge()], manager: socket.client });

    const response = await account(core);

    expect(response.json()).toEqual({
      username: "test.bridge",
      baseTopic: "zigbee2mqtt",
    });
    expect(socket.received).toContainEqual({
      method: "PUT",
      url: "/api/services/zigbee2mqtt/apps/test.bridge",
      body: undefined,
    });
  });

  it("wait for a manager that is not answering yet", async () => {
    let up = false;
    const socket = await servicesSocket(() =>
      up
        ? { status: 200, body: { connection: zigbeeConnection } }
        : { status: 503, body: { error: "starting" } },
    );
    const core = await testCore({ apps: [bridge()], manager: socket.client });

    const pending = account(core);
    await vi.waitFor(() => expect(socket.received.length).toBeGreaterThan(2));
    up = true;

    expect((await pending).json()).toMatchObject({ username: "test.bridge" });
  });

  it("fail the app's calls when the manager refuses, without asking again", async () => {
    const socket = await servicesSocket(() => ({
      status: 404,
      body: { error: "No service zigbee2mqtt for apps" },
    }));
    const core = await testCore({ apps: [bridge()], manager: socket.client });

    const response = await account(core);

    expect(response.json()).toEqual({ error: "app_failed" });
    expect(asked(socket)).toHaveLength(1);
    expect(core.logs).toContain(
      "apps: the manager did not run zigbee2mqtt for test.bridge (HTTP 404: No service zigbee2mqtt for apps)",
    );
  });

  it("are released when the app is removed, and its data stays", async () => {
    const socket = await servicesSocket(({ method }) =>
      method === "PUT"
        ? { status: 200, body: { connection: zigbeeConnection } }
        : { status: 204 },
    );
    const core = await testCore({ apps: [bridge()], manager: socket.client });
    await vi.waitFor(() => expect(asked(socket)).toHaveLength(1));

    await core.apps.remove("test.bridge");

    expect(asked(socket)).toEqual([
      {
        method: "PUT",
        url: "/api/services/zigbee2mqtt/apps/test.bridge",
        body: undefined,
      },
      {
        method: "DELETE",
        url: "/api/services/zigbee2mqtt/apps/test.bridge",
        body: undefined,
      },
    ]);
    expect(core.apps.list()).toEqual([]);
    expect((await account(core)).json()).toEqual({ error: "not_found" });
    expect(existsSync(join(core.dataDir, "apps", "test.bridge.db"))).toBe(true);
  });

  it("are given only to apps that hold their permission", async () => {
    const fake = fakeManager();
    const core = await testCore({
      apps: [bridge({ id: "test.plain", permissions: [] })],
      manager: fake.manager,
    });

    const response = await account(core, "test.plain");

    expect(response.json()).toEqual({ error: "app_failed" });
    expect(core.logs).toContain(
      "apps: bridge.account failed (test.plain does not hold services:zigbee2mqtt)",
    );
    expect(fake.calls).toEqual([]);
  });
});

describe("an app's origin", () => {
  it("keeps system apps installed with their services", async () => {
    const fake = fakeManager();
    const core = await testCore({
      apps: [bridge({ origin: "system" })],
      manager: fake.manager,
    });

    await expect(core.apps.remove("test.bridge")).rejects.toThrow("forbidden");

    expect(core.apps.list()).toHaveLength(1);
    expect((await account(core)).statusCode).toBe(200);
    expect(fake.calls).toEqual(["PUT zigbee2mqtt test.bridge"]);
  });

  it("decides whether it may have services: a third-party app may not", async () => {
    const fake = fakeManager();
    const core = await testCore({
      apps: [
        bridge({ origin: "third-party" }),
        bridge({ origin: "third-party", id: "test.quiet", permissions: [] }),
        bridge({ origin: "system", id: "test.system" }),
      ],
      manager: fake.manager,
    });

    expect(core.apps.list().map(({ id, origin }) => [id, origin])).toEqual([
      ["test.quiet", "third-party"],
      ["test.system", "system"],
    ]);
    expect(core.logs).toContain(
      "apps: test.bridge was not installed (a third-party app cannot have services)",
    );
    expect(fake.calls).toEqual(["PUT zigbee2mqtt test.system"]);
  });
});

describe("the manager client", () => {
  it("treats a refusal as final and a broken answer as a refusal", async () => {
    const socket = await managerSocket(({ method }) =>
      method === "DELETE"
        ? { status: 400, body: { error: "x is not an app id" } }
        : { status: 200, body: { connection: "none" } },
    );

    await expect(
      socket.client.releaseService("zigbee2mqtt", "x"),
    ).rejects.toThrow(new ManagerRefusal("HTTP 400: x is not an app id", 400));
    await expect(
      socket.client.needService("zigbee2mqtt", "test.bridge"),
    ).rejects.toThrow("The manager's answer was not understood");
    expect(socket.received).toHaveLength(2);
  });
});
