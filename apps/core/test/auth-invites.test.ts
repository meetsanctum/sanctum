import { inviteMs, inviteTries } from "@meetsanctum/auth-protocol";
import { eq } from "drizzle-orm";
import { assert, describe, expect, it, vi } from "vitest";

import { activity } from "../src/activity/schema.js";
import { defaultLimits, type Limits } from "../src/auth/limits.js";
import { authClients, authInvites, authLogins } from "../src/auth/schema.js";
import {
  addPerson,
  checkInvite,
  finishInvite,
  invite,
  redeem,
  registerInvite,
} from "./invite-support.js";
import {
  claimed,
  deferredDelivery,
  get,
  hostId,
  maya,
  post,
  setLogin,
  sharedClient,
  signIn,
  testCore,
} from "./support.js";

async function invited(limits?: Partial<Limits>) {
  const core = await testCore({ limits });
  const claim = await claimed(core);
  const jonas = await addPerson(core, claim.token, "Jonas");
  const made = await invite(core, claim.token, jonas.id);
  return { core, claim, jonas, made };
}

function wrongCode(code: string) {
  return code.slice(0, -1) + (code.endsWith("2") ? "3" : "2");
}

const actions = (core: Awaited<ReturnType<typeof testCore>>) =>
  core.db
    .select()
    .from(activity)
    .all()
    .map((entry) => [entry.action, entry.outcome, entry.reason]);

describe("inviting a person to sign in", () => {
  it("lets the invited person join with their own username and password", async () => {
    const { core, jonas, made } = await invited();
    expect(made.info).toMatchObject({
      personId: jonas.id,
      kind: "invite",
      ended: null,
    });

    const joined = await redeem(core, made.code!, { username: " Jonas " });

    assert(joined.outcome === "joined");
    expect(joined.checked).toMatchObject({
      person: { id: jonas.id, name: "Jonas" },
      username: null,
    });
    const { body } = joined;
    expect(body).toMatchObject({
      person: { id: jonas.id },
      client: { kind: "personal", personId: jonas.id },
    });
    const me = await get(core, "/api/auth/me", { token: body.token });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      person: { id: jonas.id },
      client: { id: body.client.id, personId: jonas.id },
    });
    // The invite is used up, and Jonas signs in with what Jonas chose.
    expect(core.db.select().from(authInvites).all()).toEqual([]);
    const signedIn = await signIn(core, {
      username: "jonas",
      password: "staple battery horse",
    });
    expect(signedIn.outcome).toBe("signed-in");
    expect(actions(core)).toEqual([
      ["host.claim", "ok", null],
      ["person.add", "ok", null],
      ["invite.create", "ok", null],
      ["invite.redeem", "ok", null],
      ["sign-in", "ok", null],
    ]);
  });

  it("lists invites for every client, shared ones too", async () => {
    const { core, jonas } = await invited();
    const tablet = sharedClient(core);

    const listed = await get(core, "/api/auth/invites", {
      token: tablet.token,
    });

    expect(listed.json()).toEqual([
      expect.objectContaining({ personId: jonas.id, ended: null }),
    ]);
  });

  it("names the person invited in the activity log", async () => {
    const { core, claim, jonas } = await invited();
    const log = await get(core, "/api/activity", { token: claim.token });

    expect(log.statusCode).toBe(200);
    expect(log.json().entries).toContainEqual(
      expect.objectContaining({
        action: "invite.create",
        subject: { type: "person", id: jonas.id, name: "Jonas", gone: false },
      }),
    );
  });

  it("works once", async () => {
    const { core, made } = await invited();
    await redeem(core, made.code!);

    const again = await redeem(core, made.code!, { username: "jonas2" });

    // The used invite is gone, so its lookup finds nothing.
    expect(again.outcome).toBe("failed-on-device");
  });

  it("ends after a day, and a right code then hears that it ended", async () => {
    const { core, claim, jonas, made } = await invited();
    core.advance(inviteMs);

    const late = await redeem(core, made.code!);

    expect(late.outcome).toBe("refused");
    if (late.outcome === "refused") {
      expect(late.response.statusCode).toBe(410);
      expect(late.response.json()).toEqual({ error: "invite_ended" });
    }
    // The invite list keeps the reason it ended.
    const listed = await get(core, "/api/auth/invites", {
      token: claim.token,
    });
    expect(listed.json()).toEqual([
      expect.objectContaining({ personId: jonas.id, ended: "expired" }),
    ]);
    expect(
      core.db
        .select()
        .from(authInvites)
        .where(eq(authInvites.personId, jonas.id))
        .get(),
    ).toBeDefined();
  });

  it("refuses an invite that expires while the person chooses a password", async () => {
    const { core, made } = await invited();
    core.advance(inviteMs - 1);
    const checked = await checkInvite(core, made.code!);
    assert(checked.outcome === "checked");
    const registered = await registerInvite(core, checked);
    assert(registered.outcome === "registered");

    core.advance(1);
    const finished = await finishInvite(core, checked, registered.input);

    assert(finished.outcome === "refused");
    expect(finished.response.statusCode).toBe(410);
    expect(finished.response.json()).toEqual({ error: "invite_ended" });
    expect(core.db.select().from(authLogins).all()).toHaveLength(1);
    expect(core.db.select().from(authClients).all()).toHaveLength(1);
  });

  it("needs a client to list or make invites", async () => {
    const { core, jonas } = await invited();

    expect((await get(core, "/api/auth/invites")).statusCode).toBe(401);
    expect(
      (
        await post(core, "/api/auth/invites/start", {
          personId: jonas.id,
          registrationRequest: "abc",
        })
      ).statusCode,
    ).toBe(401);
  });

  it("limits wrong codes temporarily and accepts the right code after the cooldown", async () => {
    const { core, claim, jonas, made } = await invited();
    const wrong = wrongCode(made.code!);

    for (let i = 0; i < inviteTries; i++) {
      expect((await redeem(core, wrong)).outcome).toBe("failed-on-device");
    }
    const right = await redeem(core, made.code!);

    expect(right.outcome).toBe("failed-on-device");
    const listed = await get(core, "/api/auth/invites", {
      token: claim.token,
    });
    expect(listed.json()).toEqual([
      expect.objectContaining({ personId: jonas.id, ended: null }),
    ]);
    expect(actions(core)).toContainEqual([
      "invite.redeem",
      "refused",
      "too_many_attempts",
    ]);
    core.advance(defaultLimits.attemptWindowMs);
    expect((await redeem(core, made.code!)).outcome).toBe("joined");
  });

  it.each([{ workPerSecond: 3 }, { openPerAddress: 1 }])(
    "does not count a challenge the host was too busy to issue (%j)",
    async (limits) => {
      const { core, made } = await invited(limits);
      expect((await redeem(core, wrongCode(made.code!))).outcome).toBe(
        "failed-on-device",
      );

      const busy = await checkInvite(core, made.code!);

      assert(busy.outcome === "refused");
      expect(busy.response.statusCode).toBe(429);
      expect(busy.response.json()).toEqual({ error: "busy" });
      expect(
        core.db.select({ tries: authInvites.tries }).from(authInvites).get(),
      ).toEqual({ tries: 1 });
    },
  );

  it("clears the tries once the right code checks", async () => {
    const { core, made } = await invited();
    const wrong = wrongCode(made.code!);
    for (let i = 0; i < inviteTries - 1; i++) {
      await redeem(core, wrong);
    }

    const taken = await redeem(core, made.code!, { username: "maya" });

    // The code checked, so its tries start again, though the username is
    // Maya's.
    expect(taken.outcome).toBe("refused");
    expect(
      core.db.select({ tries: authInvites.tries }).from(authInvites).get(),
    ).toEqual({ tries: 0 });
  });

  it("refuses a code cancelled during the check", async () => {
    const { core, claim, jonas, made } = await invited();
    const verifying = deferredDelivery();
    const cancelled = deferredDelivery();
    const subtle = crypto.subtle;
    const verify = subtle.verify.bind(subtle);
    const pause = vi
      .spyOn(subtle, "verify")
      .mockImplementationOnce(async (...args) => {
        verifying.resolve();
        await cancelled.promise;
        return verify(...args);
      });
    const checking = checkInvite(core, made.code!);
    try {
      await verifying.promise;
      const cancellation = await post(
        core,
        "/api/auth/invites/cancel",
        { personId: jonas.id },
        { token: claim.token },
      );
      expect(cancellation.statusCode).toBe(204);
    } finally {
      cancelled.resolve();
      pause.mockRestore();
    }
    const checked = await checking;
    assert(checked.outcome === "refused");
    expect(checked.response.statusCode).toBe(410);
    expect(checked.response.json()).toEqual({ error: "invite_ended" });
  });

  it("answers a lookup no invite has like one that exists", async () => {
    const { core, made } = await invited();
    const lookup = made.code!.slice(0, 2) === "ZZ" ? "YY" : "ZZ";

    const unknown = await redeem(core, `${lookup}${made.code!.slice(2)}`);

    expect(unknown.outcome).toBe("failed-on-device");
  });

  it("can be cancelled, and a new one replaces the last", async () => {
    const { core, claim, jonas, made } = await invited();

    const cancelled = await post(
      core,
      "/api/auth/invites/cancel",
      { personId: jonas.id },
      { token: claim.token },
    );
    expect(cancelled.statusCode).toBe(204);
    expect((await redeem(core, made.code!)).outcome).toBe("refused");

    const fresh = await invite(core, claim.token, jonas.id);
    expect(fresh.info).toMatchObject({ ended: null });
    expect(core.db.select().from(authInvites).all()).toHaveLength(1);
    expect((await redeem(core, fresh.code!)).outcome).toBe("joined");
  });

  it("refuses a code checked through another host, before anything is saved", async () => {
    const { core, made } = await invited();

    const intercepted = await redeem(core, made.code!, {
      sees: { hostId, homeId: core.homeId, pin: "interceptor-pin" },
    });

    expect(intercepted.outcome).toBe("refused");
    if (intercepted.outcome === "refused") {
      expect(intercepted.response.json()).toEqual({
        error: "channel_mismatch",
      });
    }
    expect(core.db.select().from(authLogins).all()).toHaveLength(1);
  });

  it("refuses a finish with an invalid binding and leaves the invite available", async () => {
    const { core, made } = await invited();
    const checked = await checkInvite(core, made.code!);
    assert(checked.outcome === "checked");
    const registered = await registerInvite(core, checked);
    assert(registered.outcome === "registered");
    const { binding } = registered.input;

    const finished = await finishInvite(core, checked, {
      ...registered.input,
      binding: (binding.startsWith("A") ? "B" : "A") + binding.slice(1),
    });

    assert(finished.outcome === "refused");
    expect(finished.response.statusCode).toBe(403);
    expect(finished.response.json()).toEqual({ error: "channel_mismatch" });
    expect(core.db.select().from(authLogins).all()).toHaveLength(1);
    expect(core.db.select().from(authClients).all()).toHaveLength(1);
    expect((await redeem(core, made.code!)).outcome).toBe("joined");
  });

  it("lets the person choose another username after a registration conflict", async () => {
    const { core, made } = await invited();
    const checked = await checkInvite(core, made.code!);
    assert(checked.outcome === "checked");

    const taken = await registerInvite(core, checked, maya.username);
    assert(taken.outcome === "refused");
    expect(taken.response.json()).toEqual({ error: "username_taken" });
    expect(core.db.select().from(authClients).all()).toHaveLength(1);

    const available = await registerInvite(core, checked);
    assert(available.outcome === "registered");
    expect((await finishInvite(core, checked, available.input)).outcome).toBe(
      "joined",
    );
  });

  it("lets the person choose another username after a finish conflict", async () => {
    const { core, claim, made } = await invited();
    const checked = await checkInvite(core, made.code!);
    assert(checked.outcome === "checked");
    const registered = await registerInvite(core, checked);
    assert(registered.outcome === "registered");
    const other = await addPerson(core, claim.token, "Robin");
    const login = await setLogin(core, claim.token, {
      personId: other.id,
      username: "jonas",
      password: "a different password",
    });
    expect(login.statusCode).toBe(204);

    const taken = await finishInvite(core, checked, registered.input);
    assert(taken.outcome === "refused");
    expect(taken.response.json()).toEqual({ error: "username_taken" });
    const available = await registerInvite(core, checked, "jonas2");
    assert(available.outcome === "registered");
    expect((await finishInvite(core, checked, available.input)).outcome).toBe(
      "joined",
    );
  });

  it("keeps a sign-in set after the first-time invite was issued", async () => {
    const { core, claim, jonas, made } = await invited();
    const login = { username: "jonas", password: "an existing password" };
    expect(
      (await setLogin(core, claim.token, { personId: jonas.id, ...login }))
        .statusCode,
    ).toBe(204);

    const finished = await redeem(core, made.code!);

    assert(finished.outcome === "refused");
    expect(finished.response.statusCode).toBe(410);
    expect(finished.response.json()).toEqual({ error: "invite_ended" });
    expect((await signIn(core, login)).outcome).toBe("signed-in");
  });

  it("goes with the person when they are removed", async () => {
    const { core, claim, jonas } = await invited();

    await post(
      core,
      "/api/people/remove",
      { id: jonas.id },
      { token: claim.token },
    );

    expect(core.db.select().from(authInvites).all()).toEqual([]);
  });
});

describe("resetting a forgotten password", () => {
  it("clears the reset code when the person's sign-in is removed", async () => {
    const { core, claim, jonas } = await invited();
    const login = await setLogin(core, claim.token, {
      personId: jonas.id,
      username: "jonas",
      password: "an existing password",
    });
    expect(login.statusCode).toBe(204);
    const reset = await invite(core, claim.token, jonas.id);
    expect(reset.info).toMatchObject({ kind: "reset", ended: null });

    const removed = await post(
      core,
      "/api/auth/logins/remove",
      { personId: jonas.id },
      { token: claim.token },
    );
    expect(removed.statusCode).toBe(204);
    expect(core.db.select().from(authInvites).all()).toEqual([]);
  });

  it("keeps the current password until the code is used", async () => {
    const core = await testCore();
    const claim = await claimed(core);

    const made = await invite(core, claim.token, claim.person.id);
    expect(made.info).toMatchObject({ kind: "reset" });
    expect((await signIn(core)).outcome).toBe("signed-in");

    const reset = await redeem(core, made.code!, {
      username: maya.username,
      password: "a brand new password",
    });

    expect(reset.outcome).toBe("joined");
    expect(reset.checked).toMatchObject({ username: maya.username });
    expect((await signIn(core)).outcome).toBe("failed-on-device");
    expect(
      (
        await signIn(core, {
          username: maya.username,
          password: "a brand new password",
        })
      ).outcome,
    ).toBe("signed-in");
    expect(actions(core)).toContainEqual(["invite.redeem", "ok", "reset"]);
  });
});
