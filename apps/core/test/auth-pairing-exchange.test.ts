import {
  newPairingSecret,
  pairingAnswerMs,
  type PairExchangeStarted,
} from "@meetsanctum/auth-protocol";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { activity } from "../src/activity/schema.js";
import { createCoreCertificates } from "../src/certificate.js";
import { testCa } from "./certificates.js";
import {
  approve,
  checked,
  device,
  exchangeStatus,
  lookUp,
  tabletAddress,
  type TestDevice,
} from "./pairing-support.js";
import {
  claimed,
  hostId,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// The exchange that checks a shared device: only the device showing the code
// finishes it, only on a connection to this host, and each request allows a
// few exchanges, counted as they start.

async function typed(
  core: TestCore,
  token: string,
  shown: TestDevice,
  code = shown.code,
) {
  const response = await lookUp(core, token, code);
  expect(response.statusCode).toBe(200);
  return response.json<PairExchangeStarted>();
}

function checks(core: TestCore) {
  return core.db
    .select()
    .from(activity)
    .where(eq(activity.action, "pair.check"))
    .all();
}

// A code with the device's lookup and another secret.
function mistyped(shown: TestDevice) {
  let secret = newPairingSecret();
  while (secret === shown.secret) {
    secret = newPairingSecret();
  }
  return `${shown.lookup}${secret}`;
}

describe("the pairing exchange", () => {
  it("says a code doesn't match when the device shows another", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const shown = await device(core);

    const started = await typed(core, maya.token, shown, mistyped(shown));
    const answered = await shown.answer();

    expect(answered.body).toEqual({ status: "failed" });
    expect(await exchangeStatus(core, maya.token, started)).toEqual({
      status: "failed",
      reason: "wrong_code",
    });
    // The right code still works: one mistyped code ends nothing.
    await checked(core, maya.token, shown);
    expect(checks(core)).toEqual([]);
  });

  it("cancels a request once its exchanges run out, and reports it", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const shown = await device(core);

    for (let i = 0; i < 3; i += 1) {
      await typed(core, maya.token, shown, mistyped(shown));
      await shown.answer();
    }

    const fourth = await lookUp(core, maya.token, shown.code);
    expect(fourth.statusCode).toBe(404);
    expect((await shown.poll()).json()).toEqual({ error: "expired" });
    expect(checks(core)).toEqual([
      expect.objectContaining({
        outcome: "refused",
        reason: "too_many_attempts",
        clientId: maya.client.id,
        address: tabletAddress,
      }),
    ]);
  });

  it("counts an exchange as it starts, so one the device never answers counts too", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const shown = await device(core);

    const started = await typed(core, maya.token, shown);
    core.advance(pairingAnswerMs);
    expect(await exchangeStatus(core, maya.token, started)).toEqual({
      status: "failed",
      reason: "no_answer",
    });
    // The device's late answer finds no exchange.
    expect((await shown.poll()).json()).toEqual({ status: "waiting" });

    await typed(core, maya.token, shown);
    core.advance(pairingAnswerMs);
    await typed(core, maya.token, shown);
    core.advance(pairingAnswerMs);
    expect((await lookUp(core, maya.token, shown.code)).statusCode).toBe(404);
  });

  it("runs one exchange at a time for a request", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const shown = await device(core);

    await typed(core, maya.token, shown);
    const second = await lookUp(core, maya.token, shown.code);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: "busy" });
  });

  it("lets the same client resume a verified exchange with the right code", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const other = sharedClient(core);
    const shown = await device(core);
    const started = await checked(core, maya.token, shown);

    expect((await lookUp(core, other.token, shown.code)).json()).toEqual({
      error: "busy",
    });
    expect((await lookUp(core, maya.token, mistyped(shown))).json()).toEqual({
      error: "busy",
    });
    const resumed = await typed(core, maya.token, shown);
    expect(resumed).toEqual(started);
    expect(
      (await approve(core, maya.token, resumed, "Kitchen tablet")).statusCode,
    ).toBe(204);
  });

  it("retries an exchange once the core has budget for its next step", async () => {
    const core = await testCore({ limits: { workPerSecond: 1 } });
    const maya = await claimed(core);
    const shown = await device(core);
    core.advance(1_000);

    await typed(core, maya.token, shown);
    const deferred = await shown.answer();
    expect(deferred.response.statusCode).toBe(429);
    expect(deferred.body).toEqual({ error: "busy" });

    core.advance(1_000);
    expect((await shown.answer()).body.status).toBe("continue");
    expect((await shown.bind()).statusCode).toBe(204);
  });

  it("binds the pin of the core's configured certificate and confirms the token with it", async () => {
    const certificates = createCoreCertificates({
      sign: (await testCa()).sign,
      log: () => undefined,
    });
    const { pin } = await certificates.first();
    const core = await testCore({ certificates });
    const maya = await claimed(core);
    const shown = await device(core);
    const started = await typed(core, maya.token, shown);
    await shown.answer();

    const view = { hostId, homeId: core.homeId, pin };
    expect((await shown.bind(view)).statusCode).toBe(204);
    expect(
      (await approve(core, maya.token, started, "Kitchen tablet")).statusCode,
    ).toBe(204);
    const { status, token, confirmation } = (await shown.poll()).json();
    expect(status).toBe("paired");
    expect(await shown.confirms(token, confirmation, view)).toBe(true);
    expect(await shown.confirms(token, confirmation)).toBe(false);
  });

  it("takes one answer for each exchange, and gives the same reply again", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const shown = await device(core);
    const started = await typed(core, maya.token, shown);

    const first = await shown.answer().catch(() => undefined);
    // The poll now waits: the exchange has its answer.
    expect((await shown.poll()).json()).toEqual({ status: "waiting" });
    const again = await post(
      core,
      "/api/auth/pair/answer",
      {
        deviceSecret: shown.deviceSecret,
        exchangeId: started.exchangeId,
        loginResponse: first!.loginResponse,
      },
      { remoteAddress: tabletAddress },
    );
    expect(again.json()).toEqual(first!.body);
  });

  it("refuses a device that sees another host, and reports it", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const shown = await device(core);
    const started = await typed(core, maya.token, shown);
    await shown.answer();

    const bound = await shown.bind({
      hostId,
      homeId: core.homeId,
      pin: "aW50ZXJjZXB0b3ItY2VydGlmaWNhdGUtcGluLWJ5dGVz",
    });

    expect(bound.statusCode).toBe(403);
    expect(bound.json()).toEqual({ error: "channel_mismatch" });
    expect(await exchangeStatus(core, maya.token, started)).toEqual({
      status: "failed",
      reason: "channel_mismatch",
    });
    expect((await shown.poll()).json()).toEqual({ error: "expired" });
    expect(checks(core)).toEqual([
      expect.objectContaining({
        outcome: "refused",
        reason: "channel_mismatch",
      }),
    ]);
  });

  it("refuses a view without the exchange's MAC", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const shown = await device(core);
    const started = await typed(core, maya.token, shown);
    await shown.answer();

    const bound = await shown.bind(undefined, "bm90LXRoZS1tYWM");

    expect(bound.statusCode).toBe(403);
    expect(await exchangeStatus(core, maya.token, started)).toEqual({
      status: "failed",
      reason: "unchecked",
    });
    expect(checks(core)).toEqual([
      expect.objectContaining({ reason: "unchecked" }),
    ]);
  });

  it("cancels a request whose device answered but never bound its view", async () => {
    const core = await testCore();
    const maya = await claimed(core);
    const shown = await device(core);
    const started = await typed(core, maya.token, shown);
    await shown.answer();

    core.advance(pairingAnswerMs);

    expect(await exchangeStatus(core, maya.token, started)).toEqual({
      status: "failed",
      reason: "unchecked",
    });
    expect((await shown.bind()).statusCode).toBe(409);
    expect((await shown.poll()).json()).toEqual({ error: "expired" });
  });

  it("refuses a code for a request no device is showing", async () => {
    const core = await testCore();
    const maya = await claimed(core);

    const response = await lookUp(core, maya.token, "K7QXM4PD");

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });
});
