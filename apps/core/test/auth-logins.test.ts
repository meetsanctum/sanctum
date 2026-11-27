import {
  keyStretching,
  liveInvalidTokenCode,
  type RegistrationStarted,
} from "@meetsanctum/auth-protocol";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { activity } from "../src/activity/schema.js";
import { authLogins } from "../src/auth/schema.js";
import { openLive } from "./devices-support.js";
import {
  hostId,
  changePassword,
  choosePassword,
  claimed,
  get,
  maya,
  post,
  registration,
  setLogin,
  sharedClient,
  signIn,
  testCore,
  type TestCore,
} from "./support.js";

const jonas = { name: "Jonas", colour: "#b9defc" } as const;

async function withJonas(core: TestCore) {
  const claim = await claimed(core);
  const person = core.people.add(jonas);
  return { claim, person };
}

async function tokenFor(core: TestCore, username: string, password: string) {
  const result = await signIn(core, { username, password });
  if (result.outcome !== "signed-in") throw new Error(result.outcome);
  return result.body.token;
}

describe("logins", () => {
  it("are set by someone, and work for signing in", async () => {
    const core = await testCore();
    const { claim, person } = await withJonas(core);

    const set = await setLogin(core, claim.token, {
      personId: person.id,
      username: "Jonas",
      password: "jonas's password",
    });

    expect(set.statusCode).toBe(204);
    expect(
      (await signIn(core, { username: "jonas", password: "jonas's password" }))
        .outcome,
    ).toBe("signed-in");
  });

  it("are reset by setting them again, which ends the old password", async () => {
    const core = await testCore();
    const { claim, person } = await withJonas(core);
    await setLogin(core, claim.token, {
      personId: person.id,
      username: "jonas",
      password: "first password",
    });

    await setLogin(core, claim.token, {
      personId: person.id,
      username: "jonas",
      password: "second password",
    });

    expect(
      (await signIn(core, { username: "jonas", password: "first password" }))
        .outcome,
    ).toBe("failed-on-device");
    expect(
      (await signIn(core, { username: "jonas", password: "second password" }))
        .outcome,
    ).toBe("signed-in");
  });

  it("are managed by everyone, shared clients too", async () => {
    const core = await testCore();
    const { claim, person } = await withJonas(core);
    await setLogin(core, claim.token, {
      personId: person.id,
      username: "jonas",
      password: "jonas's password",
    });
    const token = await tokenFor(core, "jonas", "jonas's password");
    const kitchen = sharedClient(core);
    const ida = core.people.add({ name: "Ida", colour: "#8fb5c9" });

    const reset = await setLogin(core, token, {
      personId: claim.person.id,
      username: "maya",
      password: "a new password for maya",
    });
    const set = await setLogin(core, kitchen.token, {
      personId: ida.id,
      username: "ida",
      password: "ida's own password",
    });
    const removed = await post(
      core,
      "/api/auth/logins/remove",
      { personId: ida.id },
      { token: kitchen.token },
    );

    expect(reset.statusCode).toBe(204);
    expect(set.statusCode).toBe(204);
    expect(removed.statusCode).toBe(204);
    expect(
      (
        await signIn(core, {
          username: "maya",
          password: "a new password for maya",
        })
      ).outcome,
    ).toBe("signed-in");
  });

  it("keep usernames unique", async () => {
    const core = await testCore();
    const { claim, person } = await withJonas(core);

    const response = await setLogin(core, claim.token, {
      personId: person.id,
      username: "maya",
      password: "jonas's password",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "username_taken" });
  });

  it("are removed, but never the last one", async () => {
    const core = await testCore();
    const { claim, person } = await withJonas(core);

    const last = await post(
      core,
      "/api/auth/logins/remove",
      { personId: claim.person.id },
      { token: claim.token },
    );
    expect(last.statusCode).toBe(409);
    expect(last.json()).toEqual({ error: "last_login" });

    await setLogin(core, claim.token, {
      personId: person.id,
      username: "jonas",
      password: "jonas's password",
    });
    const removed = await post(
      core,
      "/api/auth/logins/remove",
      { personId: claim.person.id },
      { token: claim.token },
    );
    expect(removed.statusCode).toBe(204);
    expect(core.db.select().from(authLogins).all()).toMatchObject([
      { username: "jonas" },
    ]);
  });

  it("are listed for every client, shared ones too, by username", async () => {
    const core = await testCore();
    const { claim, person } = await withJonas(core);
    const kitchen = sharedClient(core);
    await setLogin(core, claim.token, {
      personId: person.id,
      username: "jonas",
      password: "jonas's password",
    });

    const listed = await get(core, "/api/auth/logins", {
      token: kitchen.token,
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      { personId: person.id, username: "jonas" },
      { personId: claim.person.id, username: "maya" },
    ]);
    expect((await get(core, "/api/auth/logins")).statusCode).toBe(401);
  });

  it("take their person's devices with them when removed", async () => {
    const core = await testCore();
    const { claim, person } = await withJonas(core);
    await setLogin(core, claim.token, {
      personId: person.id,
      username: "jonas",
      password: "jonas's password",
    });
    const phone = await tokenFor(core, "jonas", "jonas's password");
    const kitchen = sharedClient(core);
    const connected = await openLive(core, phone);

    const removed = await post(
      core,
      "/api/auth/logins/remove",
      { personId: person.id },
      { token: kitchen.token },
    );

    expect(removed.statusCode).toBe(204);
    expect((await connected.closed).code).toBe(liveInvalidTokenCode);
    expect((await get(core, "/api/auth/me", { token: phone })).statusCode).toBe(
      401,
    );
    // Everyone else stays signed in, and the person stays in People.
    expect(
      (await get(core, "/api/auth/me", { token: claim.token })).statusCode,
    ).toBe(200);
    expect(
      (await get(core, "/api/auth/me", { token: kitchen.token })).statusCode,
    ).toBe(200);
    expect(core.people.list().map(({ name }) => name)).toContain("Jonas");
  });
});

describe("the login rule", () => {
  it("counts only people who can sign in", async () => {
    const core = await testCore();
    // Jonas has no login.
    const { claim } = await withJonas(core);

    expect(() => core.people.remove(claim.person.id)).toThrow(
      expect.objectContaining({ code: "last_login" }),
    );
  });

  it("lets a person go once another can sign in, and the host stays claimed", async () => {
    const core = await testCore();
    const { claim, person } = await withJonas(core);
    await setLogin(core, claim.token, {
      personId: person.id,
      username: "jonas",
      password: "jonas's password",
    });

    core.people.remove(claim.person.id);

    // Her login and clients went with her.
    expect(core.db.select().from(authLogins).all()).toHaveLength(1);
    expect(core.auth.isClaimed()).toBe(true);
    expect(
      (
        await core.server.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { authorization: `Bearer ${claim.token}` },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("changing your own password", () => {
  it("needs the current password, and replaces it", async () => {
    const core = await testCore();
    const { token } = await claimed(core);

    const changed = await changePassword(core, token, {
      current: maya.password,
      next: "a new password",
    });

    expect(changed).toMatchObject({ statusCode: 204 });
    expect((await signIn(core)).outcome).toBe("failed-on-device");
    expect((await signIn(core, { password: "a new password" })).outcome).toBe(
      "signed-in",
    );
  });

  it("fails on the device with a wrong current password", async () => {
    const core = await testCore();
    const { token } = await claimed(core);

    const changed = await changePassword(core, token, {
      current: "not my password",
      next: "a new password",
    });

    expect(changed).toBe("failed-on-device");
    expect((await signIn(core)).outcome).toBe("signed-in");
  });

  it("is refused when the device saw another host", async () => {
    const core = await testCore();
    const { token } = await claimed(core);

    const changed = await changePassword(core, token, {
      current: maya.password,
      next: "a new password",
      sees: { hostId, homeId: core.homeId, pin: "interceptor-pin" },
    });

    expect(changed).toMatchObject({ statusCode: 403 });
    expect((await signIn(core)).outcome).toBe("signed-in");
  });
});

describe("choosing a new password without the current one", () => {
  const finishUrl = "/api/auth/password/choose/finish";

  async function startChoice(core: TestCore, token: string) {
    const started = registration("a new password");
    const response = await post(
      core,
      "/api/auth/password/choose/start",
      { registrationRequest: started.registrationRequest },
      { token },
    );
    expect(response.statusCode).toBe(200);
    const { registrationId, registrationResponse } =
      response.json<RegistrationStarted>();
    return {
      registrationId,
      registrationRecord: started.finish(registrationResponse),
      keyStretching: keyStretching.version,
    };
  }

  it("replaces the password and keeps existing devices signed in", async () => {
    const core = await testCore();
    const { token, person, client } = await claimed(core);
    const other = await tokenFor(core, maya.username, maya.password);

    const chosen = await choosePassword(core, token, "a new password");

    expect(chosen).toMatchObject({ statusCode: 204 });
    expect((await signIn(core)).outcome).toBe("failed-on-device");
    expect((await signIn(core, { password: "a new password" })).outcome).toBe(
      "signed-in",
    );
    expect((await get(core, "/api/auth/me", { token })).statusCode).toBe(200);
    expect((await get(core, "/api/auth/me", { token: other })).statusCode).toBe(
      200,
    );
    expect(
      core.db
        .select()
        .from(activity)
        .where(eq(activity.action, "password.choose"))
        .all(),
    ).toEqual([
      expect.objectContaining({
        outcome: "ok",
        personId: person.id,
        clientId: client.id,
      }),
    ]);
  });

  it("rejects a malformed record and keeps the current password", async () => {
    const core = await testCore();
    const { token } = await claimed(core);
    const input = await startChoice(core, token);

    const refused = await post(
      core,
      finishUrl,
      { ...input, registrationRecord: input.registrationRecord.slice(0, 8) },
      { token },
    );

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "invalid_request" });
    expect((await signIn(core)).outcome).toBe("signed-in");
  });

  it("can only finish on the device that started the choice", async () => {
    const core = await testCore();
    const { token } = await claimed(core);
    const other = await tokenFor(core, maya.username, maya.password);
    const input = await startChoice(core, token);

    const refused = await post(core, finishUrl, input, { token: other });

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "expired" });
    expect((await signIn(core)).outcome).toBe("signed-in");
  });

  it("refuses to finish if the device's authorization was revoked", async () => {
    const core = await testCore();
    const { token, client } = await claimed(core);
    const other = await tokenFor(core, maya.username, maya.password);
    const input = await startChoice(core, token);
    const caller = core.auth.authenticate(token);
    expect(caller).toBeDefined();
    const revoked = await post(
      core,
      "/api/auth/clients/revoke",
      { id: client.id },
      { token: other },
    );
    expect(revoked.statusCode).toBe(204);

    // The initial request hook saw the device before it was revoked.
    const authenticate = vi
      .spyOn(core.auth, "authenticate")
      .mockReturnValueOnce(caller);
    try {
      const refused = await post(core, finishUrl, input, { token });

      expect(refused.statusCode).toBe(401);
      expect(refused.json()).toEqual({ error: "invalid_client_token" });
    } finally {
      authenticate.mockRestore();
    }
    expect((await signIn(core)).outcome).toBe("signed-in");
  });

  it("is refused on a shared device, which has no one to sign in as", async () => {
    const core = await testCore();
    await claimed(core);
    const kitchen = sharedClient(core);

    const chosen = await choosePassword(core, kitchen.token, "a new password");

    expect(chosen).toMatchObject({ statusCode: 403 });
    expect((await signIn(core)).outcome).toBe("signed-in");
  });

  it("ends when the sign-in changed in between, and keeps that change", async () => {
    const core = await testCore();
    const { token, person } = await claimed(core);

    const chosen = await choosePassword(core, token, "a new password", () =>
      setLogin(core, token, {
        personId: person.id,
        username: "maya",
        password: "set in between",
      }),
    );

    expect(chosen).toMatchObject({ statusCode: 409 });
    expect((await signIn(core, { password: "set in between" })).outcome).toBe(
      "signed-in",
    );
  });
});
