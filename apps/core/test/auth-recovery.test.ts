import type { InviteInfo } from "@meetsanctum/auth-protocol";
import { describe, expect, it } from "vitest";

import { addPerson, invite, redeem } from "./invite-support.js";
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

  it("chooses a new password, keeps the username, and is spent", async () => {
    const core = await testCore();
    const claim = await claimed(core);
    const made = await invite(core, claim.token, claim.person.id, "recovery");

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

  it("ends when you make a new one", async () => {
    const core = await testCore();
    const claim = await claimed(core);
    const first = await invite(core, claim.token, claim.person.id, "recovery");
    const second = await invite(core, claim.token, claim.person.id, "recovery");

    const old = await redeem(core, first.code!, {
      username: maya.username,
      password: "from the old code",
    });

    expect(old.outcome).not.toBe("joined");
    expect(await listed(core, claim.token)).toEqual([
      expect.objectContaining({ id: second.info!.id }),
    ]);
  });
});
