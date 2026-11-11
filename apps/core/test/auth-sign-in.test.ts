import { signInBinding } from "@meetsanctum/auth-protocol";
import * as opaque from "@serenity-kit/opaque";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { activity } from "../src/activity/schema.js";
import { authClients, authLogins } from "../src/auth/schema.js";
import { hostId, claimed, get, maya, signIn, testCore } from "./support.js";

describe("signing in", () => {
  it("gives a new device a personal client the host confirms", async () => {
    const core = await testCore();
    const claim = await claimed(core);

    const result = await signIn(core);

    expect(result.outcome).toBe("signed-in");
    const body = result.outcome === "signed-in" ? result.body : undefined;
    expect(body).toMatchObject({
      person: { id: claim.person.id, name: "Maya" },
      client: { kind: "personal", personId: claim.person.id, current: true },
    });
    expect(body?.token).not.toBe(claim.token);
    const me = await get(core, "/api/auth/me", { token: body!.token });
    expect(me.json()).toMatchObject({
      client: { id: body!.client.id },
      person: { name: "Maya" },
    });
    expect(
      core.db
        .select()
        .from(activity)
        .all()
        .map((entry) => [entry.action, entry.outcome]),
    ).toEqual([
      ["host.claim", "ok"],
      ["sign-in", "ok"],
    ]);
  });

  it("fails on the device with a wrong password", async () => {
    const core = await testCore();
    await claimed(core);

    const result = await signIn(core, { password: "wrong horse battery" });

    expect(result.outcome).toBe("failed-on-device");
    expect(core.db.select().from(authClients).all()).toHaveLength(1);
  });

  it("answers an unknown username like a known one", async () => {
    const core = await testCore();
    await claimed(core);

    const result = await signIn(core, { username: "ruth" });

    expect(result.outcome).toBe("failed-on-device");
  });

  it("refuses a sign-in whose device saw another host, before any token exists", async () => {
    const core = await testCore();
    await claimed(core);

    const elsewhere = await signIn(core, {
      sees: { hostId: "another-host", homeId: core.homeId, pin: null },
    });
    const anotherHome = await signIn(core, {
      sees: { hostId, homeId: "another-home", pin: null },
    });
    // A device that saw an interceptor's certificate.
    const intercepted = await signIn(core, {
      sees: { hostId, homeId: core.homeId, pin: "interceptor-pin" },
    });

    for (const result of [elsewhere, anotherHome, intercepted]) {
      expect(result.outcome).toBe("refused");
      if (result.outcome === "refused") {
        expect(result.response.statusCode).toBe(403);
        expect(result.response.json()).toEqual({ error: "channel_mismatch" });
      }
    }
    expect(core.db.select().from(authClients).all()).toHaveLength(1);
    expect(
      core.db
        .select()
        .from(activity)
        .where(eq(activity.reason, "channel_mismatch"))
        .all(),
    ).toHaveLength(3);
  });

  it("binds the pin of the host CA the core serves", async () => {
    const pin = "hg6mmQxxksnFQb7m8qDqK0hT9z6lRb6vS8aW2b0FbUQ";
    const core = await testCore({ pin });
    await claimed(core);

    // A device that saw no certificate, or another CA's.
    for (const sees of [
      { hostId, homeId: core.homeId, pin: null },
      { hostId, homeId: core.homeId, pin: "interceptor-pin" },
    ]) {
      const result = await signIn(core, { sees });
      expect(result.outcome).toBe("refused");
    }
    const pinned = await signIn(core, {
      sees: { hostId, homeId: core.homeId, pin },
    });
    expect(pinned.outcome).toBe("signed-in");
  });

  it("finishes once and within a minute", async () => {
    const core = await testCore();
    await claimed(core);

    const first = await signIn(core);
    expect(first.outcome).toBe("signed-in");

    // The pending sign-in is gone once it expires.
    const start = opaque.client.startLogin({ password: maya.password });
    const started = await core.server.inject({
      method: "POST",
      url: "/api/auth/sign-in/start",
      payload: { username: "maya", startLoginRequest: start.startLoginRequest },
    });
    core.advance(60_000);
    const finish = await core.server.inject({
      method: "POST",
      url: "/api/auth/sign-in/finish",
      payload: {
        signInId: started.json().signInId,
        finishLoginRequest: "AAAA",
        binding: "AAAA",
        client: { name: "Laptop", platform: "macos" },
      },
    });
    expect(finish.statusCode).toBe(401);
    expect(finish.json()).toEqual({ error: "sign_in_failed" });
  });

  it("is invalidated by a password reset since it started", async () => {
    const core = await testCore();
    const { person } = await claimed(core);
    const login = opaque.client.startLogin({ password: maya.password });
    const start = await core.server.inject({
      method: "POST",
      url: "/api/auth/sign-in/start",
      payload: { username: "maya", startLoginRequest: login.startLoginRequest },
    });

    // Another device resets the record in between.
    core.db
      .update(authLogins)
      .set({ registrationRecord: "replaced" })
      .where(eq(authLogins.personId, person.id))
      .run();

    const finished = opaque.client.finishLogin({
      clientLoginState: login.clientLoginState,
      loginResponse: start.json().loginResponse,
      password: maya.password,
      keyStretching: {
        "argon2id-custom": { iterations: 1, memory: 1024, parallelism: 1 },
      },
    })!;
    const finish = await core.server.inject({
      method: "POST",
      url: "/api/auth/sign-in/finish",
      payload: {
        signInId: start.json().signInId,
        finishLoginRequest: finished.finishLoginRequest,
        binding: await signInBinding(finished.sessionKey, {
          hostId,
          homeId: core.homeId,
          pin: null,
        }),
        client: { name: "Laptop", platform: "macos" },
      },
    });

    expect(finish.json()).toEqual({ error: "sign_in_failed" });
    expect(core.db.select().from(authClients).all()).toHaveLength(1);
  });

  it("fails generically for a malformed message", async () => {
    const core = await testCore();
    await claimed(core);

    const response = await core.server.inject({
      method: "POST",
      url: "/api/auth/sign-in/start",
      payload: { username: "maya", startLoginRequest: "AAAA" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
  });
});
