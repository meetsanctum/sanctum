import { inviteMs, inviteTries } from "@meetsanctum/auth-protocol";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { activity } from "../src/activity/schema.js";
import { authClients, authInvites, authLogins } from "../src/auth/schema.js";
import { addPerson, invite, redeem } from "./invite-support.js";
import {
  claimed,
  get,
  hostId,
  maya,
  post,
  sharedClient,
  signIn,
  testCore,
} from "./support.js";

async function invited() {
  const core = await testCore();
  const claim = await claimed(core);
  const jonas = await addPerson(core, claim.token, "Jonas");
  const made = await invite(core, claim.token, jonas.id);
  return { core, claim, jonas, made };
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

    const joined = await redeem(core, made.code!);

    expect(joined.outcome).toBe("joined");
    expect(joined.checked).toMatchObject({
      person: { id: jonas.id, name: "Jonas" },
      username: null,
    });
    const body = joined.outcome === "joined" ? joined.body : undefined;
    expect(body).toMatchObject({
      person: { id: jonas.id },
      client: { kind: "personal", personId: jonas.id },
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
    // It stays, so Jonas's page can say it ran out.
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

  it("fails a wrong code on the device, and ends the invite after too many tries", async () => {
    const { core, claim, jonas, made } = await invited();
    const wrong = `${made.code!.slice(0, 2)}${"2".repeat(6)}`;

    for (let i = 0; i < inviteTries; i++) {
      expect((await redeem(core, wrong)).outcome).toBe("failed-on-device");
    }
    const right = await redeem(core, made.code!);

    expect(right.outcome).toBe("refused");
    if (right.outcome === "refused") {
      expect(right.response.json()).toEqual({ error: "invite_ended" });
    }
    const listed = await get(core, "/api/auth/invites", {
      token: claim.token,
    });
    expect(listed.json()).toEqual([
      expect.objectContaining({ personId: jonas.id, ended: "wrong_code" }),
    ]);
    expect(actions(core)).toContainEqual([
      "invite.redeem",
      "refused",
      "too_many_attempts",
    ]);
  });

  it("clears the tries once the right code checks", async () => {
    const { core, made } = await invited();
    const wrong = `${made.code!.slice(0, 2)}${"2".repeat(6)}`;
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

  it("refuses a username someone else has", async () => {
    const { core, made } = await invited();

    const taken = await redeem(core, made.code!, { username: maya.username });

    expect(taken.outcome).toBe("refused");
    if (taken.outcome === "refused") {
      expect(taken.response.json()).toEqual({ error: "username_taken" });
    }
    expect(core.db.select().from(authClients).all()).toHaveLength(1);
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
