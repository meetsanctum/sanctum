import { inviteMs, type InviteInfo } from "@meetsanctum/auth-protocol";
import { eq } from "drizzle-orm";
import { assert, describe, expect, it } from "vitest";

import { authInvites } from "../src/auth/schema.js";
import {
  addPerson,
  checkInvite,
  finishInvite,
  invite,
  redeem,
  registerInvite,
  startInvite,
} from "./invite-support.js";
import {
  changePassword,
  choosePassword,
  claimed,
  get,
  maya,
  setLogin,
  sharedClient,
  signIn,
  testCore,
  type TestCore,
} from "./support.js";

// A recovery code is a reset with no end that a person makes for
// themselves, on their own device, for when they forget their password and
// no device is signed in as them. Only their own devices see it, a reset
// someone else makes leaves it, and using it spends it.

async function listed(core: TestCore, token: string) {
  const response = await get(core, "/api/auth/invites", { token });
  expect(response.statusCode).toBe(200);
  return response.json<InviteInfo[]>();
}

async function withJonas() {
  const core = await testCore();
  const claim = await claimed(core);
  const jonas = await addPerson(core, claim.token, "Jonas");
  await setLogin(core, claim.token, {
    personId: jonas.id,
    username: "jonas",
    password: "jonas's password",
  });
  const signedIn = await signIn(core, {
    username: "jonas",
    password: "jonas's password",
  });
  if (signedIn.outcome !== "signed-in") throw new Error(signedIn.outcome);
  return { core, claim, jonas, jonasToken: signedIn.body.token };
}

describe("a recovery code", () => {
  it("is made on your own device and listed only to your own devices", async () => {
    const { core, claim, jonasToken } = await withJonas();
    const kitchen = sharedClient(core);

    const made = await invite(core, claim.token, claim.person.id, "recovery");

    expect(made.info).toMatchObject({ kind: "recovery", ended: null });
    expect(await listed(core, claim.token)).toEqual([
      expect.objectContaining({ id: made.info!.id, kind: "recovery" }),
    ]);
    expect(await listed(core, jonasToken)).toEqual([]);
    expect(await listed(core, kitchen.token)).toEqual([]);
  });

  it("can't be made for someone else, or on a shared device", async () => {
    const { core, claim, jonas } = await withJonas();
    const kitchen = sharedClient(core);

    const forJonas = await invite(core, claim.token, jonas.id, "recovery");
    const onKitchen = await invite(
      core,
      kitchen.token,
      claim.person.id,
      "recovery",
    );

    expect(forJonas.response.statusCode).toBe(403);
    expect(onKitchen.response.statusCode).toBe(403);
  });

  it("chooses a new password after the ordinary invite lifetime, then is spent", async () => {
    const core = await testCore();
    const claim = await claimed(core);
    const made = await invite(core, claim.token, claim.person.id, "recovery");
    core.advance(inviteMs + 1);

    const used = await redeem(core, made.code!, {
      username: maya.username,
      password: "a recovered password",
    });

    expect(used.outcome).toBe("joined");
    expect(used.checked).toMatchObject({ username: maya.username });
    expect((await signIn(core)).outcome).toBe("failed-on-device");
    expect(
      (await signIn(core, { password: "a recovered password" })).outcome,
    ).toBe("signed-in");
    expect(await listed(core, claim.token)).toEqual([]);
    const again = await redeem(core, made.code!, {
      username: maya.username,
      password: "once more",
    });
    expect(again.outcome).not.toBe("joined");
  });

  it("stays beside a reset someone else makes, and after a password you set", async () => {
    const { core, claim, jonasToken } = await withJonas();
    const made = await invite(core, claim.token, claim.person.id, "recovery");

    const reset = await invite(core, jonasToken, claim.person.id, "reset");
    expect(reset.info).toMatchObject({ kind: "reset" });
    expect(
      await changePassword(core, claim.token, {
        current: maya.password,
        next: "changed once",
      }),
    ).toMatchObject({ statusCode: 204 });
    expect(
      await choosePassword(core, claim.token, "chosen once"),
    ).toMatchObject({ statusCode: 204 });

    const used = await redeem(core, made.code!, {
      username: maya.username,
      password: "a recovered password",
    });
    expect(used.outcome).toBe("joined");
  });

  it("can still finish after a reset is issued, and cancels that reset", async () => {
    const { core, claim, jonasToken } = await withJonas();
    const made = await invite(core, claim.token, claim.person.id, "recovery");
    const recovery = await checkInvite(core, made.code!);
    assert(recovery.outcome === "checked");

    const reset = await invite(core, jonasToken, claim.person.id, "reset");
    const resetChecked = await checkInvite(core, reset.code!);
    assert(resetChecked.outcome === "checked");
    const resetRegistered = await registerInvite(
      core,
      resetChecked,
      maya.username,
    );
    assert(resetRegistered.outcome === "registered");

    const registered = await registerInvite(
      core,
      recovery,
      maya.username,
      "a recovered password",
    );
    assert(registered.outcome === "registered");
    expect((await finishInvite(core, recovery, registered.input)).outcome).toBe(
      "joined",
    );

    const late = await finishInvite(core, resetChecked, resetRegistered.input);
    assert(late.outcome === "refused");
    expect(late.response.json()).toEqual({ error: "invite_ended" });
    expect(await listed(core, claim.token)).toEqual([
      expect.objectContaining({ id: reset.info!.id, ended: "cancelled" }),
    ]);
    expect(
      (await signIn(core, { password: "a recovered password" })).outcome,
    ).toBe("signed-in");
  });

  it("ends when you make a new one", async () => {
    const core = await testCore();
    const claim = await claimed(core);
    const first = await invite(core, claim.token, claim.person.id, "recovery");
    const pending = await startInvite(
      core,
      claim.token,
      claim.person.id,
      "recovery",
      first.info!.id,
    );
    const second = await invite(
      core,
      claim.token,
      claim.person.id,
      "recovery",
      first.info!.id,
    );
    expect(second.response.statusCode).toBe(200);
    const stale = await pending.finish!();
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "invite_changed" });
    const unconfirmed = await invite(
      core,
      claim.token,
      claim.person.id,
      "recovery",
    );
    expect(unconfirmed.response.statusCode).toBe(409);
    expect(unconfirmed.response.json()).toEqual({ error: "invite_changed" });

    const old = await redeem(core, first.code!, {
      username: maya.username,
      password: "from the old code",
    });

    expect(old.outcome).not.toBe("joined");
    expect(await listed(core, claim.token)).toEqual([
      expect.objectContaining({ id: second.info!.id }),
    ]);
  });

  it("refuses a lookup taken by another code for the same person", async () => {
    const { core, claim, jonasToken } = await withJonas();
    const pending = await startInvite(
      core,
      claim.token,
      claim.person.id,
      "recovery",
    );
    const reset = await invite(core, jonasToken, claim.person.id, "reset");
    core.db
      .update(authInvites)
      .set({ lookup: pending.lookup! })
      .where(eq(authInvites.id, reset.info!.id))
      .run();

    const response = await pending.finish!();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "expired" });
    expect(await listed(core, claim.token)).toEqual([reset.info]);
  });
});
