import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { authClients } from "../src/auth/schema.js";
import {
  claimed,
  get,
  post,
  setLogin,
  sharedClient,
  signIn,
  testCore,
  type TestCore,
} from "./support.js";

describe("the request check", () => {
  it("needs a client token on every route but the public ones", async () => {
    const core = await testCore();
    const { token } = await claimed(core);

    for (const call of [
      {},
      { token: "client_unknown" },
      { headers: { authorization: `Basic ${token}` } },
    ]) {
      const response = await get(core, "/api/auth/me", call);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid_client_token" });
    }
    expect((await get(core, "/api/auth/me", { token })).statusCode).toBe(200);
    expect((await get(core, "/api/health")).statusCode).toBe(200);
    expect((await get(core, "/api/auth/status")).statusCode).toBe(200);
  });

  it("refuses a revoked client's token from its next request on", async () => {
    const core = await testCore();
    const { token, client } = await claimed(core);

    const revoked = await post(
      core,
      "/api/auth/clients/revoke",
      { id: client.id },
      { token },
    );

    expect(revoked.statusCode).toBe(204);
    const after = await get(core, "/api/auth/me", { token });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: "invalid_client_token" });
  });

  it("updates the last-seen time at most once a minute", async () => {
    const core = await testCore();
    const { token, client } = await claimed(core);
    const lastSeen = () =>
      core.db
        .select({ at: authClients.lastSeenAt })
        .from(authClients)
        .where(eq(authClients.id, client.id))
        .get()!.at!;
    const claimedAt = lastSeen().getTime();

    core.advance(30_000);
    await get(core, "/api/auth/me", { token });
    expect(lastSeen().getTime()).toBe(claimedAt);

    core.advance(30_000);
    await get(core, "/api/auth/me", { token });
    expect(lastSeen().getTime()).toBe(claimedAt + 60_000);
  });

  it("lets shared clients manage clients and logins, but not a password", async () => {
    const core = await testCore();
    await claimed(core);
    const shared = sharedClient(core);

    const me = await get(core, "/api/auth/me", { token: shared.token });
    const listed = await get(core, "/api/auth/clients", {
      token: shared.token,
    });
    // A password belongs to a person, which a shared client has not.
    const password = await post(
      core,
      "/api/auth/password/start",
      { startLoginRequest: "A", registrationRequest: "A" },
      { token: shared.token },
    );

    expect(me.json()).toMatchObject({
      client: { kind: "shared", name: "Kitchen tablet" },
      person: null,
    });
    expect(listed.json()).toHaveLength(2);
    expect(password.statusCode).toBe(403);
    expect(password.json()).toEqual({ error: "needs_personal_client" });
  });
});

describe("clients", () => {
  it("are listed, renamed and revoked by their person", async () => {
    const core = await testCore();
    const claim = await claimed(core);
    const other = await signIn(core);
    if (other.outcome !== "signed-in") throw new Error(other.outcome);

    const listed = await get(core, "/api/auth/clients", { token: claim.token });
    expect(
      listed
        .json()
        .map((client: { id: string; current: boolean }) => [
          client.id,
          client.current,
        ]),
    ).toEqual([
      [claim.client.id, true],
      [other.body.client.id, false],
    ]);

    const renamed = await post(
      core,
      "/api/auth/clients/rename",
      { id: other.body.client.id, name: " Old laptop " },
      { token: claim.token },
    );
    expect(renamed.json()).toMatchObject({
      name: "Old laptop",
      current: false,
    });

    await post(
      core,
      "/api/auth/clients/revoke",
      { id: other.body.client.id },
      { token: claim.token },
    );
    expect(
      (await get(core, "/api/auth/clients", { token: claim.token })).json(),
    ).toHaveLength(1);
    expect(
      (await get(core, "/api/auth/me", { token: other.body.token })).statusCode,
    ).toBe(401);
  });

  it("turn Reduce effects and Reduce motion on and off as any client sets them", async () => {
    const core = await testCore();
    const claim = await claimed(core);
    const display = sharedClient(core);
    // The display hears the change at once over its live connection.
    const heard: unknown[] = [];
    core.auth.connections.add(core.auth.clients.authenticate(display.token)!, {
      close() {},
      send: (message) => heard.push(JSON.parse(String(message))),
    });
    const heardByEditor: unknown[] = [];
    core.auth.connections.add(core.auth.clients.authenticate(claim.token)!, {
      close() {},
      send: (message) => heardByEditor.push(JSON.parse(String(message))),
    });
    const me = async () =>
      (await get(core, "/api/auth/me", { token: display.token })).json().client;
    expect(await me()).toMatchObject({
      reduceEffects: false,
      reduceMotion: false,
    });

    const set = await post(
      core,
      "/api/auth/clients/drawing",
      { id: display.id, reduceEffects: true },
      { token: claim.token },
    );
    // Reduce motion stays off: each is turned on on its own.
    expect(set.json()).toMatchObject({
      id: display.id,
      reduceEffects: true,
      reduceMotion: false,
      current: false,
    });
    expect(heard).toEqual([{ type: "client" }]);
    expect(heardByEditor).toEqual([]);
    await post(
      core,
      "/api/auth/clients/drawing",
      { id: display.id, reduceMotion: true },
      { token: claim.token },
    );
    await post(
      core,
      "/api/auth/clients/drawing",
      { id: display.id, reduceEffects: false },
      { token: claim.token },
    );
    expect(await me()).toMatchObject({
      reduceEffects: false,
      reduceMotion: true,
    });
    const listed = (
      await get(core, "/api/auth/clients", { token: claim.token })
    ).json();
    expect(
      listed.find((client: { id: string }) => client.id === display.id),
    ).toMatchObject({ reduceEffects: false, reduceMotion: true });
    expect(heard).toHaveLength(3);

    // The same again tells it nothing.
    await post(
      core,
      "/api/auth/clients/drawing",
      { id: display.id, reduceMotion: true },
      { token: claim.token },
    );
    expect(heard).toHaveLength(3);
  });

  it("refuse anything but on or off, and an agent's drawing", async () => {
    const core = await testCore();
    const claim = await claimed(core);
    const display = sharedClient(core);
    for (const body of [
      { id: display.id, reduceEffects: "on" },
      { id: display.id, reduceMotion: "automatic" },
    ]) {
      const refused = await post(core, "/api/auth/clients/drawing", body, {
        token: claim.token,
      });
      expect(refused.statusCode).toBe(400);
    }

    const agent = core.auth.clients.createAgent({
      name: "Codex on the office Mac",
      platform: "macos",
      addedBy: { kind: "person", id: claim.client.personId! },
    });
    const refused = await post(
      core,
      "/api/auth/clients/drawing",
      { id: agent.client.id, reduceEffects: true },
      { token: claim.token },
    );
    expect(refused.statusCode).toBe(404);
  });

  it("of someone else are managed by everyone, shared clients too", async () => {
    const core = await testCore();
    const claim = await claimed(core);
    const shared = sharedClient(core);
    const jonas = core.people.add({
      name: "Jonas",
      colour: "#b9defc",
    });
    // Jonas signs in on his own phone.
    await setLogin(core, claim.token, {
      personId: jonas.id,
      username: "jonas",
      password: "jonas's password",
    });
    const phone = await signIn(core, {
      username: "jonas",
      password: "jonas's password",
    });
    if (phone.outcome !== "signed-in") throw new Error(phone.outcome);
    const token = phone.body.token;

    const listed = (await get(core, "/api/auth/clients", { token })).json();
    expect(listed).toHaveLength(3);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: claim.client.id, current: false }),
        expect.objectContaining({ id: shared.id, current: false }),
        expect.objectContaining({ id: phone.body.client.id, current: true }),
      ]),
    );
    const renamed = await post(
      core,
      "/api/auth/clients/rename",
      { id: claim.client.id, name: "Maya's laptop" },
      { token: shared.token },
    );
    const revoked = await post(
      core,
      "/api/auth/clients/revoke",
      { id: shared.id },
      { token },
    );

    expect(renamed.json()).toMatchObject({ name: "Maya's laptop" });
    expect(revoked.statusCode).toBe(204);
    expect(
      (await get(core, "/api/auth/me", { token: shared.token })).statusCode,
    ).toBe(401);
  });
});

describe("the live WebSocket", () => {
  async function open(core: TestCore) {
    await core.server.ready();
    const socket = await core.server.injectWS("/api/live");
    const messages: unknown[] = [];
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.on("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      ),
    );
    socket.on("message", (data) => messages.push(JSON.parse(String(data))));
    return { socket, messages, closed };
  }

  const nextMessage = (socket: WebSocket) =>
    new Promise((resolve) =>
      socket.once("message", (data) => resolve(JSON.parse(String(data)))),
    );

  it("authenticates with its first message", async () => {
    const core = await testCore();
    const { token } = await claimed(core);
    const { socket } = await open(core);

    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: "auth", token }));

    expect(await ready).toEqual({ type: "ready" });
    socket.terminate();
  });

  it("closes on a wrong first message", async () => {
    const core = await testCore();
    await claimed(core);
    const { socket, messages, closed } = await open(core);

    socket.send(JSON.stringify({ type: "auth", token: "client_unknown" }));

    expect(await closed).toEqual({
      code: 4401,
      reason: "invalid_client_token",
    });
    expect(messages).toEqual([]);
  });

  it("closes when its client is revoked", async () => {
    const core = await testCore();
    const { token, client } = await claimed(core);
    const { socket, closed } = await open(core);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: "auth", token }));
    await ready;

    await post(core, "/api/auth/clients/revoke", { id: client.id }, { token });

    expect((await closed).code).toBe(4401);
  });
});
