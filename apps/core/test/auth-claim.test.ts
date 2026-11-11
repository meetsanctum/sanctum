import { describe, expect, it } from "vitest";

import { activity } from "../src/activity/schema.js";
import { authLogins, authTokens } from "../src/auth/schema.js";
import { hashToken } from "../src/auth/tokens.js";
import {
  hostId,
  claim,
  claimed,
  get,
  maya,
  post,
  registration,
  testCore,
} from "./support.js";

describe("claiming the host", () => {
  it("starts unclaimed", async () => {
    const core = await testCore();

    const status = await get(core, "/api/auth/status");

    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      hostId,
      homeId: core.homeId,
      claimed: false,
    });
  });

  it("creates the first person, their login and this device's client at once", async () => {
    const core = await testCore();

    const response = await claim(core, { username: " Maya " });

    expect(response.statusCode).toBe(200);
    const signedIn = response.json();
    expect(signedIn).toMatchObject({
      person: { name: "Maya", colour: "#c5cdac", avatar: null },
      client: {
        kind: "personal",
        name: "Maya's MacBook",
        platform: "macos",
        current: true,
      },
    });
    expect(signedIn.token).toMatch(/^client_[A-Za-z0-9_-]{43}$/);
    expect(signedIn.confirmation).toBeUndefined();
    expect(signedIn.client.personId).toBe(signedIn.person.id);

    expect(core.people.list()).toHaveLength(1);
    const login = core.db.select().from(authLogins).get();
    expect(login).toMatchObject({
      personId: signedIn.person.id,
      username: "maya",
      keyStretching: 1,
    });
    // Only the token's hash is kept.
    const token = core.db.select().from(authTokens).get();
    expect(token?.tokenHash).toBe(hashToken(signedIn.token));
    expect(
      JSON.stringify(core.db.select().from(authTokens).all()),
    ).not.toContain(signedIn.token);

    expect((await get(core, "/api/auth/status")).json()).toEqual({
      hostId,
      homeId: core.homeId,
      claimed: true,
    });
    expect(core.claims).toEqual([true]);
    expect(core.db.select().from(activity).all()).toMatchObject([
      { source: "auth", action: "host.claim", outcome: "ok" },
    ]);
  });

  it("happens once", async () => {
    const core = await testCore();
    await claimed(core);

    const again = await claim(core, { username: "jonas" });

    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "claimed" });
    expect(core.people.list()).toHaveLength(1);
  });

  it("lets only one of two parallel registrations claim", async () => {
    const core = await testCore();
    const first = registration(maya.password);
    const second = registration("another password");
    const starts = await Promise.all(
      [first, second].map((started, index) =>
        post(core, "/api/auth/claim/start", {
          username: index ? "jonas" : "maya",
          registrationRequest: started.registrationRequest,
        }),
      ),
    );
    const finish = (index: number) => {
      const { registrationId, registrationResponse } = starts[index]!.json();
      return post(core, "/api/auth/claim/finish", {
        registrationId,
        registrationRecord: [first, second][index]!.finish(
          registrationResponse,
        ),
        keyStretching: 1,
        person: maya.person,
        client: { name: "Laptop", platform: "macos" },
      });
    };

    const results = await Promise.all([finish(0), finish(1)]);

    expect(results.map((result) => result.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(core.people.list()).toHaveLength(1);
    expect(core.claims).toEqual([true]);
  });

  it("finishes only from the address that started it, within a minute", async () => {
    const core = await testCore();
    const started = registration(maya.password);
    const start = (
      await post(core, "/api/auth/claim/start", {
        username: "maya",
        registrationRequest: started.registrationRequest,
      })
    ).json();
    const finish = (remoteAddress?: string) =>
      post(
        core,
        "/api/auth/claim/finish",
        {
          registrationId: start.registrationId,
          registrationRecord: started.finish(start.registrationResponse),
          keyStretching: 1,
          person: maya.person,
          client: { name: "Laptop", platform: "macos" },
        },
        { remoteAddress },
      );

    expect((await finish("192.168.1.99")).json()).toEqual({
      error: "expired",
    });
    // Taken by the failed attempt: a registration can be used once.
    expect((await finish()).statusCode).toBe(409);
    expect(core.auth.isClaimed()).toBe(false);

    const late = await claim(core);
    expect(late.statusCode).toBe(200);
  });

  it("refuses a registration that expired", async () => {
    const core = await testCore();
    const started = registration(maya.password);
    const start = (
      await post(core, "/api/auth/claim/start", {
        username: "maya",
        registrationRequest: started.registrationRequest,
      })
    ).json();

    core.advance(60_000);
    const finish = await post(core, "/api/auth/claim/finish", {
      registrationId: start.registrationId,
      registrationRecord: started.finish(start.registrationResponse),
      keyStretching: 1,
      person: maya.person,
      client: { name: "Laptop", platform: "macos" },
    });

    expect(finish.json()).toEqual({ error: "expired" });
  });

  it.each([
    { username: "x" },
    { username: "maya b" },
    { person: { name: " ", colour: "#c5cdac" } },
    { person: { name: "Maya", colour: "sage" } },
  ])("checks its input: %j", async (input) => {
    const core = await testCore();

    const response = await claim(core, input);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
    expect(core.auth.isClaimed()).toBe(false);
  });

  it("waits for the host's id from the manager", async () => {
    const core = await testCore({ hostId: null });

    const status = await get(core, "/api/auth/status");

    expect(status.statusCode).toBe(503);
    expect(status.json()).toEqual({ error: "host_starting" });
  });
});
