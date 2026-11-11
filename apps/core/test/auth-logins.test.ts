import { describe, expect, it } from "vitest";

import { authLogins } from "../src/auth/schema.js";
import {
  hostId,
  changePassword,
  claimed,
  maya,
  post,
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
