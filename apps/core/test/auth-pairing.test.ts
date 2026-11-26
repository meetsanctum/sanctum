import {
  formatPairingCode,
  type PairExchangeStarted,
} from "@meetsanctum/auth-protocol";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { activity } from "../src/activity/schema.js";
import { authClients, authPairingRequests } from "../src/auth/schema.js";
import {
  approve,
  checked,
  device,
  exchangeStatus,
  lookUp,
  paired,
  tablet,
  tabletAddress,
} from "./pairing-support.js";
import {
  claimed,
  get,
  post,
  setLogin,
  sharedClient,
  signIn,
  testCore,
} from "./support.js";

// Pairing a shared device: the device asks and polls, another client types
// its code, the host checks the device through an OPAQUE exchange, and the
// client that typed the code approves it, a shared one too. The exchange's
// failures are in auth-pairing-exchange.test.ts.

describe("pairing a shared device", () => {
  it("gives the device a shared client once its code is checked and approved", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const shown = await device(core);

    expect(shown.lookup).toMatch(/^[2-9A-HJKMNP-TV-Z]{2}$/);
    expect(shown.expiresAt).toBe("2026-10-26T12:10:00.000Z");
    expect((await shown.poll()).json()).toEqual({ status: "waiting" });

    const lookedUp = await lookUp(
      core,
      maya.token,
      formatPairingCode(shown.code).toLowerCase(),
    );
    expect(lookedUp.statusCode).toBe(200);
    const started = lookedUp.json<PairExchangeStarted>();
    expect(started.requestId).toBe(shown.requestId);
    expect(await exchangeStatus(core, maya.token, started)).toEqual({
      status: "exchanging",
    });

    const answered = await shown.answer();
    expect(answered.body.status).toBe("continue");
    expect(await exchangeStatus(core, maya.token, started)).toEqual({
      status: "exchanging",
    });
    expect((await shown.bind()).statusCode).toBe(204);
    expect(await exchangeStatus(core, maya.token, started)).toEqual({
      status: "verified",
      request: {
        platform: "android",
        suggestedName: "Lenovo Tab",
        createdAt: "2026-10-26T12:00:00.000Z",
        expiresAt: "2026-10-26T12:10:00.000Z",
      },
    });
    expect((await shown.poll()).json()).toEqual({ status: "waiting" });

    const approved = await approve(core, maya.token, started, "Kitchen tablet");
    expect(approved.statusCode).toBe(204);

    const collected = await shown.poll();
    expect(collected.statusCode).toBe(200);
    const body = collected.json();
    expect(body).toMatchObject({
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
    expect(await shown.confirms(body.token, body.confirmation)).toBe(true);
    expect(await shown.confirms("client_other", body.confirmation)).toBe(false);

    const me = await get(core, "/api/auth/me", { token: body.token });
    expect(me.json()).toMatchObject({
      client: { kind: "shared", name: "Kitchen tablet" },
      person: null,
    });
  });

  it("shows the new client as never seen until it uses its token", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const { token, client } = await paired(core, maya.token);

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

  it("keeps neither the device's half of the code nor its secret", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const shown = await device(core);
    await checked(core, maya.token, shown);

    const stored = JSON.stringify(
      core.db.select().from(authPairingRequests).all(),
    );
    expect(stored).not.toContain(shown.secret);
    expect(stored).not.toContain(shown.deviceSecret);
  });

  it("records the approval and the pairing, without the code or secret", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const { shown, client } = await paired(core, maya.token);

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
    expect(logged).not.toContain(shown.secret);
    expect(logged).not.toContain(shown.deviceSecret);
  });

  it("hands the token only to the device holding the secret", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const kitchen = await device(core);
    const hall = await device(core, "192.168.7.51");
    const started = await checked(core, maya.token, kitchen);
    await approve(core, maya.token, started, "Kitchen tablet");

    expect((await hall.poll()).json()).toEqual({ status: "waiting" });
    const guessed = await post(core, "/api/auth/pair/poll", {
      deviceSecret: "not-the-secret",
    });
    expect(guessed.statusCode).toBe(409);
    expect(guessed.json()).toEqual({ error: "expired" });
    expect((await kitchen.poll()).json()).toMatchObject({ status: "paired" });
  });

  it("approves a request once and gives one token", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const shown = await device(core);
    const started = await checked(core, maya.token, shown);
    await approve(core, maya.token, started, "Kitchen tablet");

    const again = await approve(core, maya.token, started, "Hall");
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: "not_found" });
    expect((await lookUp(core, maya.token, shown.code)).statusCode).toBe(404);

    await shown.poll();
    // The request is used up: collecting again gives no second token.
    expect((await shown.poll()).statusCode).toBe(409);
    expect(
      core.db
        .select()
        .from(authClients)
        .where(eq(authClients.kind, "shared"))
        .all(),
    ).toHaveLength(1);
  });

  it("approves only a request its exchange checked, from the client that typed the code", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const kitchen = sharedClient(core);
    const shown = await device(core);
    const started = (
      await lookUp(core, maya.token, shown.code)
    ).json<PairExchangeStarted>();

    // Not checked yet.
    expect(
      (await approve(core, maya.token, started, "Kitchen tablet")).statusCode,
    ).toBe(404);
    await shown.answer();
    await shown.bind();

    // Another client neither follows nor approves it.
    const other = await post(core, "/api/auth/pair/exchange", started, {
      token: kitchen.token,
    });
    expect(other.statusCode).toBe(404);
    expect(
      (await approve(core, kitchen.token, started, "Kitchen tablet"))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await approve(
          core,
          maya.token,
          { ...started, exchangeId: "another-exchange" },
          "Kitchen tablet",
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await approve(core, maya.token, started, "Kitchen tablet")).statusCode,
    ).toBe(204);
  });

  it("expires a request 10 minutes after it was made, approved or not", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const unapproved = await device(core);
    const approved = await device(core);
    const checkedFirst = await checked(core, maya.token, unapproved);
    await approve(
      core,
      maya.token,
      await checked(core, maya.token, approved),
      "Kitchen tablet",
    );

    core.advance(10 * 60_000);

    expect(
      (await approve(core, maya.token, checkedFirst, "Hall")).statusCode,
    ).toBe(404);
    for (const shown of [unapproved, approved]) {
      const polled = await shown.poll();
      expect(polled.statusCode).toBe(409);
      expect(polled.json()).toEqual({ error: "expired" });
    }
  });

  it("keeps a request's lookup 10 minutes after it ends, so no other device gets it", async () => {
    const core = await testCore();
    await claimed(core);
    const first = await device(core);

    core.advance(10 * 60_000);
    // Expired, but resting: it no longer counts against the caps.
    await device(core);
    expect(core.db.select().from(authPairingRequests).all()).toHaveLength(2);
    expect(
      core.db
        .select()
        .from(authPairingRequests)
        .where(eq(authPairingRequests.lookup, first.lookup))
        .all(),
    ).toHaveLength(1);

    core.advance(10 * 60_000);
    await device(core);
    expect(
      core.db
        .select()
        .from(authPairingRequests)
        .where(eq(authPairingRequests.lookup, first.lookup))
        .all(),
    ).toHaveLength(0);
  });

  it("pairs a device another shared device approved, as the household", async () => {
    const core = await testCore();
    await claimed(core);
    const kitchen = sharedClient(core);

    const { client } = await paired(core, kitchen.token, "Hall");

    expect(client).toMatchObject({
      name: "Hall",
      kind: "shared",
      personId: null,
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

  it("lets any signed-in client type a code and approve it, shared ones too", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const kim = core.people.add({ name: "Kim", colour: "#fcd2b3" });
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
    const shown = await device(core);
    const ids = { requestId: shown.requestId, exchangeId: "x" };

    for (const [route, body] of [
      ["/api/auth/pair/lookup", { code: shown.code }],
      ["/api/auth/pair/exchange", ids],
      ["/api/auth/pair/approve", { ...ids, name: "Kitchen tablet" }],
    ] as const) {
      expect((await post(core, route, body)).statusCode, route).toBe(401);
    }
    const { client } = await paired(core, signedIn.body.token);
    expect(client.kind).toBe("shared");
    const shared = sharedClient(core);
    await paired(core, shared.token, "Hall");
  });

  it("checks what each route is given", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const secret = { deviceSecret: "abc" };

    for (const [route, body, token] of [
      ["/api/auth/pair/request", { ...tablet, platform: "amiga" }],
      ["/api/auth/pair/request", { ...tablet, suggestedName: " " }],
      // A device that speaks another pairing exchange.
      ["/api/auth/pair/request", { ...tablet, protocol: 1 }],
      ["/api/auth/pair/request", { platform: "android", suggestedName: "A" }],
      ["/api/auth/pair/poll", { deviceSecret: "not a secret!" }],
      ["/api/auth/pair/answer", { ...secret, exchangeId: "x" }],
      ["/api/auth/pair/bind", { ...secret, exchangeId: "x", binding: "b" }],
      ["/api/auth/pair/lookup", { code: "K7QX-M4P0" }, maya.token],
      ["/api/auth/pair/exchange", { requestId: "r" }, maya.token],
      [
        "/api/auth/pair/approve",
        { requestId: "r", exchangeId: "x", name: "" },
        maya.token,
      ],
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

    await device(core);
    await device(core);
    const third = await post(core, "/api/auth/pair/request", tablet, {
      remoteAddress: tabletAddress,
    });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: "busy" });

    await device(core, "192.168.7.51");
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
    await device(core);
  });

  it("counts an IPv6 device's whole /64 as one address", async () => {
    const core = await testCore({ limits: { pairingPerAddress: 1 } });
    await claimed(core);

    await device(core, "2001:db8:1:2::10");
    const sameNetwork = await post(core, "/api/auth/pair/request", tablet, {
      remoteAddress: "2001:db8:1:2::11",
    });
    expect(sameNetwork.statusCode).toBe(429);
  });

  it("signs a removed shared device out", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const { token, client } = await paired(core, maya.token);

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
