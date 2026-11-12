import {
  formatPairingCode,
  type PairRequested,
} from "@meetsanctum/auth-protocol";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { activity } from "../src/activity/schema.js";
import { authClients, authPairingRequests } from "../src/auth/schema.js";
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

// Pairing a shared device: the device asks and polls, another client looks its
// code up and approves it, a shared one too.

const tablet = { platform: "android", suggestedName: "Lenovo Tab" } as const;
const tabletAddress = "192.168.7.50";

async function ask(core: TestCore, remoteAddress = tabletAddress) {
  const response = await post(core, "/api/auth/pair/request", tablet, {
    remoteAddress,
  });
  expect(response.statusCode).toBe(200);
  return response.json<PairRequested>();
}

function poll(core: TestCore, deviceSecret: string) {
  return post(
    core,
    "/api/auth/pair/poll",
    { deviceSecret },
    { remoteAddress: tabletAddress },
  );
}

function approve(core: TestCore, token: string, code: string, name: string) {
  return post(core, "/api/auth/pair/approve", { code, name }, { token });
}

describe("pairing a shared device", () => {
  it("gives the device a shared client once an admin approves its code", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const requested = await ask(core);

    expect(requested.code).toMatch(/^[2-9A-HJKMNP-TV-Z]{8}$/);
    expect(requested.expiresAt).toBe("2026-10-26T12:10:00.000Z");
    expect((await poll(core, requested.deviceSecret)).json()).toEqual({
      status: "waiting",
    });

    const lookup = await post(
      core,
      "/api/auth/pair/lookup",
      { code: formatPairingCode(requested.code).toLowerCase() },
      { token: maya.token },
    );
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toEqual({
      code: requested.code,
      platform: "android",
      suggestedName: "Lenovo Tab",
      address: tabletAddress,
      createdAt: "2026-10-26T12:00:00.000Z",
      expiresAt: "2026-10-26T12:10:00.000Z",
    });

    const approved = await approve(
      core,
      maya.token,
      requested.code,
      "Kitchen tablet",
    );
    expect(approved.statusCode).toBe(204);

    const collected = await poll(core, requested.deviceSecret);
    expect(collected.statusCode).toBe(200);
    const paired = collected.json();
    expect(paired).toMatchObject({
      status: "paired",
      token: expect.stringMatching(/^client_/),
      client: {
        name: "Kitchen tablet",
        kind: "shared",
        platform: "android",
        personId: null,
        lastSeenAt: null,
        current: true,
      },
    });

    const me = await get(core, "/api/auth/me", { token: paired.token });
    expect(me.json()).toMatchObject({
      client: { kind: "shared", name: "Kitchen tablet" },
      person: null,
    });
  });

  it("shows the new client as never seen until it uses its token", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const requested = await ask(core);
    await approve(core, maya.token, requested.code, "Kitchen tablet");
    const { token, client } = (await poll(core, requested.deviceSecret)).json();

    const listed = () =>
      get(core, "/api/auth/clients", { token: maya.token }).then((response) =>
        response.json().find(({ id }: { id: string }) => id === client.id),
      );
    expect(await listed()).toMatchObject({ kind: "shared", lastSeenAt: null });

    await get(core, "/api/auth/me", { token });
    expect(await listed()).toMatchObject({
      lastSeenAt: "2026-10-26T12:00:00.000Z",
    });
  });

  it("keeps only hashes of the code and the device secret", async () => {
    const core = await testCore();
    await claimed(core);
    const requested = await ask(core);

    const stored = JSON.stringify(
      core.db.select().from(authPairingRequests).all(),
    );
    expect(stored).not.toContain(requested.code);
    expect(stored).not.toContain(requested.deviceSecret);
  });

  it("records the approval and the pairing, without the code or secret", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const requested = await ask(core);
    await approve(core, maya.token, requested.code, "Kitchen tablet");
    const { client } = (await poll(core, requested.deviceSecret)).json();

    const entries = core.db
      .select()
      .from(activity)
      .where(eq(activity.source, "auth"))
      .all();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "pair.approve",
          outcome: "ok",
          personId: maya.person.id,
          clientId: maya.client.id,
        }),
        expect.objectContaining({
          action: "client.pair",
          outcome: "ok",
          personId: maya.person.id,
          clientId: client.id,
          address: tabletAddress,
        }),
      ]),
    );
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain(requested.code);
    expect(logged).not.toContain(requested.deviceSecret);
  });

  it("hands the token only to the device holding the secret", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const kitchen = await ask(core);
    const hall = await ask(core, "192.168.7.51");
    await approve(core, maya.token, kitchen.code, "Kitchen tablet");

    expect((await poll(core, hall.deviceSecret)).json()).toEqual({
      status: "waiting",
    });
    const guessed = await poll(core, "not-the-secret");
    expect(guessed.statusCode).toBe(409);
    expect(guessed.json()).toEqual({ error: "expired" });
    expect((await poll(core, kitchen.deviceSecret)).json()).toMatchObject({
      status: "paired",
    });
  });

  it("refuses a code that was already approved or used", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const requested = await ask(core);
    await approve(core, maya.token, requested.code, "Kitchen tablet");

    const again = await approve(core, maya.token, requested.code, "Hall");
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: "not_found" });

    await poll(core, requested.deviceSecret);
    const lookup = await post(
      core,
      "/api/auth/pair/lookup",
      { code: requested.code },
      { token: maya.token },
    );
    expect(lookup.statusCode).toBe(404);
    // The request is used up: collecting again gives no second token.
    expect((await poll(core, requested.deviceSecret)).statusCode).toBe(409);
    expect(
      core.db
        .select()
        .from(authClients)
        .where(eq(authClients.kind, "shared"))
        .all(),
    ).toHaveLength(1);
  });

  it("expires a request 10 minutes after it was made, approved or not", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const unapproved = await ask(core);
    const approved = await ask(core);
    await approve(core, maya.token, approved.code, "Kitchen tablet");

    core.advance(10 * 60_000);

    expect(
      (await approve(core, maya.token, unapproved.code, "Hall")).statusCode,
    ).toBe(404);
    for (const { deviceSecret } of [unapproved, approved]) {
      const polled = await poll(core, deviceSecret);
      expect(polled.statusCode).toBe(409);
      expect(polled.json()).toEqual({ error: "expired" });
    }
    // Expired requests are swept when the next device asks.
    await ask(core);
    expect(core.db.select().from(authPairingRequests).all()).toHaveLength(1);
  });

  it("pairs a device another shared device approved, as the household", async () => {
    const core = await testCore();
    await claimed(core);
    const kitchen = sharedClient(core);
    const hall = await ask(core);

    const approved = await approve(core, kitchen.token, hall.code, "Hall");
    const polled = await poll(core, hall.deviceSecret);

    expect(approved.statusCode).toBe(204);
    expect(polled.json()).toMatchObject({
      status: "paired",
      client: { name: "Hall", kind: "shared", personId: null },
    });
    expect(
      core.db
        .select()
        .from(activity)
        .where(eq(activity.action, "pair.approve"))
        .all(),
    ).toEqual([
      expect.objectContaining({ personId: null, clientId: kitchen.id }),
    ]);
  });

  it("lets any client look up and approve codes, shared ones too", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const kim = core.people.add({
      name: "Kim",
      colour: "#fcd2b3",
    });
    await setLogin(core, maya.token, {
      personId: kim.id,
      username: "kim",
      password: "kim's password",
    });
    const signedIn = await signIn(core, {
      username: "kim",
      password: "kim's password",
    });
    if (signedIn.outcome !== "signed-in") throw new Error(signedIn.outcome);
    const shared = sharedClient(core);
    const { code } = await ask(core);
    const body = { code, name: "Kitchen tablet" };

    for (const route of ["/api/auth/pair/lookup", "/api/auth/pair/approve"]) {
      expect((await post(core, route, body)).statusCode).toBe(401);
    }
    const lookedUp = await post(core, "/api/auth/pair/lookup", body, {
      token: signedIn.body.token,
    });
    const approved = await post(core, "/api/auth/pair/approve", body, {
      token: shared.token,
    });

    expect(lookedUp.json()).toMatchObject({ code });
    expect(approved.statusCode).toBe(204);
  });

  it("checks what each route is given", async () => {
    const core = await testCore();
    const maya = await claimed(core);

    for (const [route, body, token] of [
      ["/api/auth/pair/request", { platform: "amiga", suggestedName: "A" }],
      ["/api/auth/pair/request", { platform: "android", suggestedName: " " }],
      ["/api/auth/pair/poll", { deviceSecret: "not a secret!" }],
      ["/api/auth/pair/lookup", { code: "K7QX-M4P0" }, maya.token],
      ["/api/auth/pair/approve", { code: "K7QXM4PD", name: "" }, maya.token],
    ] as const) {
      const response = await post(core, route, body, { token });
      expect(response.statusCode, route).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("caps open requests per address and across the host", async () => {
    const core = await testCore({
      limits: { pairingPerAddress: 2, pairingTotal: 3 },
    });
    await claimed(core);

    await ask(core);
    await ask(core);
    const third = await post(core, "/api/auth/pair/request", tablet, {
      remoteAddress: tabletAddress,
    });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: "busy" });

    await ask(core, "192.168.7.51");
    const fourth = await post(core, "/api/auth/pair/request", tablet, {
      remoteAddress: "192.168.7.52",
    });
    expect(fourth.statusCode).toBe(429);
    await post(core, "/api/auth/pair/request", tablet, {
      remoteAddress: "192.168.7.52",
    });

    // One entry for each cap reached, however often the device asks.
    expect(
      core.db
        .select()
        .from(activity)
        .where(eq(activity.action, "pair.request"))
        .all(),
    ).toEqual([
      expect.objectContaining({ outcome: "refused", address: tabletAddress }),
      expect.objectContaining({ outcome: "refused", address: "192.168.7.52" }),
    ]);

    // Expired requests no longer count.
    core.advance(10 * 60_000);
    await ask(core);
  });

  it("counts an IPv6 device's whole /64 as one address", async () => {
    const core = await testCore({ limits: { pairingPerAddress: 1 } });
    await claimed(core);

    await ask(core, "2001:db8:1:2::10");
    const sameNetwork = await post(core, "/api/auth/pair/request", tablet, {
      remoteAddress: "2001:db8:1:2::11",
    });
    expect(sameNetwork.statusCode).toBe(429);
  });

  it("signs a removed shared device out", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const requested = await ask(core);
    await approve(core, maya.token, requested.code, "Kitchen tablet");
    const { token, client } = (await poll(core, requested.deviceSecret)).json();

    const revoked = await post(
      core,
      "/api/auth/clients/revoke",
      { id: client.id },
      { token: maya.token },
    );
    expect(revoked.statusCode).toBe(204);
    const after = await get(core, "/api/auth/me", { token });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: "invalid_client_token" });
  });
});
