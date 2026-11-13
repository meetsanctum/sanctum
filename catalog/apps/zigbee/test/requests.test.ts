import { afterEach, describe, expect, it, vi } from "vitest";

import { bridgeResponse, createPendingRequests } from "../src/requests.js";

// Zigbee2MQTT's answers to bridge requests.

const answer = (payload: unknown) =>
  bridgeResponse(Buffer.from(JSON.stringify(payload)));

describe("an answer from the bridge", () => {
  it("is ok with its data and transaction", () => {
    expect(
      answer({ data: { time: 120 }, status: "ok", transaction: "t-1" }),
    ).toEqual({
      transaction: "t-1",
      ok: true,
      error: "",
      data: { time: 120 },
    });
  });

  it("is a refusal with Zigbee2MQTT's reason", () => {
    expect(
      answer({
        data: {},
        status: "error",
        error: "Coordinator is not started",
      }),
    ).toMatchObject({ ok: false, error: "Coordinator is not started" });
    expect(answer({ status: "pending" })).toMatchObject({
      ok: false,
      error: "Zigbee2MQTT refused the request",
    });
    expect(bridgeResponse(Buffer.from("nope"))).toMatchObject({
      ok: false,
      transaction: null,
    });
  });
});

describe("pending requests", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settle by transaction", async () => {
    const pending = createPendingRequests(1_000);
    const first = pending.wait("t-1", "permit join");
    const second = pending.wait("t-2", "permit join");

    pending.answer(
      answer({ status: "error", error: "no", transaction: "t-2" }),
    );
    pending.answer(
      answer({ status: "ok", data: { time: 5 }, transaction: "t-1" }),
    );

    await expect(first).resolves.toMatchObject({ data: { time: 5 } });
    await expect(second).rejects.toThrow("no");
  });

  it("ignore answers to other callers, untagged ones included", async () => {
    const pending = createPendingRequests(1_000);
    const requests = [pending.wait("a", "x"), pending.wait("b", "x")];
    const settled = vi.fn();
    const completed = Promise.all(
      requests.map((request) => request.then(settled)),
    );

    pending.answer(answer({ status: "ok" }));
    pending.answer(answer({ status: "error", error: "no" }));
    pending.answer(answer({ status: "ok", transaction: "someone-else" }));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    pending.answer(answer({ status: "ok", transaction: "a" }));
    pending.answer(answer({ status: "ok", transaction: "b" }));
    await completed;
    expect(settled).toHaveBeenCalledTimes(2);
  });

  it("fail when Zigbee2MQTT does not answer in time", async () => {
    vi.useFakeTimers();
    const pending = createPendingRequests(1_000);
    const request = pending.wait("t-1", "permit join");

    vi.advanceTimersByTime(1_000);

    await expect(request).rejects.toThrow(
      "Zigbee2MQTT did not answer: permit join",
    );
    // A late answer settles nothing.
    pending.answer(answer({ status: "ok", transaction: "t-1" }));
  });

  it("are given up when the driver stops", async () => {
    const pending = createPendingRequests(1_000);
    const request = pending.wait("t-1", "permit join");

    pending.cancel("stopped");

    await expect(request).rejects.toThrow("stopped");
  });
});
