import * as opaque from "@serenity-kit/opaque";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { activity } from "../src/activity/schema.js";
import {
  addressKey,
  createLimiter,
  defaultLimits,
} from "../src/auth/limits.js";
import { claimed, post, signIn, testCore } from "./support.js";

describe("sign-in limits", () => {
  // Open sign-ins and the host's OPAQUE budget have limits of their own.
  const roomy = { openPerAddress: 100, openTotal: 100, workPerSecond: 1_000 };

  it("stop an address after 20 sign-ins that do not finish", async () => {
    const core = await testCore({ limits: roomy });
    await claimed(core);
    const from = { remoteAddress: "192.168.1.50" };

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await signIn(core, { ...from, password: "guess" });
      expect(result.outcome).toBe("failed-on-device");
    }
    const refused = await signIn(core, from);

    expect(refused.outcome).toBe("refused");
    if (refused.outcome === "refused") {
      expect(refused.response.statusCode).toBe(429);
      expect(refused.response.json()).toEqual({ error: "too_many_attempts" });
    }
    // Another address, and the same one after 15 minutes, may try again.
    expect(
      (await signIn(core, { remoteAddress: "192.168.1.51" })).outcome,
    ).toBe("signed-in");
    core.advance(15 * 60_000);
    expect((await signIn(core, from)).outcome).toBe("signed-in");
    // The limit was logged once, with its address.
    expect(
      core.db
        .select()
        .from(activity)
        .where(eq(activity.reason, "too_many_attempts"))
        .all(),
    ).toMatchObject([{ address: "192.168.1.50" }]);
  });

  it("take back a sign-in that finished", async () => {
    const core = await testCore({ limits: roomy });
    await claimed(core);

    for (let attempt = 0; attempt < 25; attempt += 1) {
      expect((await signIn(core)).outcome).toBe("signed-in");
    }
  });

  it("cap open sign-ins per address", async () => {
    const core = await testCore({ limits: { openPerAddress: 2 } });
    await claimed(core);
    const start = () =>
      core.server.inject({
        method: "POST",
        url: "/api/auth/sign-in/start",
        payload: {
          username: "maya",
          startLoginRequest: opaque.client.startLogin({ password: "guess" })
            .startLoginRequest,
        },
      });

    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await start()).statusCode);
    }

    expect(statuses).toEqual([200, 200, 429]);
  });

  it("bound the host's OPAQUE work", () => {
    const limiter = createLimiter({
      limits: {
        ...defaultLimits,
        attempts: 20,
        attemptWindowMs: 60_000,
        trackedAddresses: 2,
        openPerAddress: 5,
        openTotal: 64,
        openMs: 60_000,
        workPerSecond: 2,
      },
      now: () => 0,
    });

    limiter.work();
    limiter.work();
    expect(() => limiter.work()).toThrow(
      expect.objectContaining({ code: "busy" }),
    );
    limiter.attempt("10.0.0.1");
    limiter.attempt("10.0.0.2");
    // Tracked addresses are capped too.
    expect(() => limiter.attempt("10.0.0.3")).toThrow(
      expect.objectContaining({ code: "busy" }),
    );
  });

  it("limit finishes without a pending sign-in before writing more activity", async () => {
    const core = await testCore({ limits: { attempts: 2 } });
    const finish = () =>
      post(core, "/api/auth/sign-in/finish", {
        signInId: "nonexistent",
        finishLoginRequest: "AAAA",
        binding: "AAAA",
        client: { name: "Laptop", platform: "macos" },
      });

    expect((await finish()).statusCode).toBe(401);
    expect((await finish()).statusCode).toBe(401);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await finish()).json()).toEqual({ error: "too_many_attempts" });
    }
    expect(core.db.select().from(activity).all()).toHaveLength(3);
    core.advance(15 * 60_000);
    expect((await finish()).statusCode).toBe(401);
  });
});

describe("addressKey", () => {
  it.each([
    ["192.168.1.20", "192.168.1.20"],
    ["::ffff:192.168.1.20", "192.168.1.20"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:0DB8:0001:0002::1", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["fe80::1%en0", "fe80:0:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
  ])("limits %s as %s", (address, key) => {
    expect(addressKey(address)).toBe(key);
  });
});
