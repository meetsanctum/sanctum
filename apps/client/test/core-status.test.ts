import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startCoreStatusPolling, type CoreStatus } from "../src/core-status";

const healthy = { service: "core", status: "ok", version: "test" };

beforeEach(() => {
  vi.stubEnv("VITE_SANCTUM_CORE_URL", "http://core.test:4100");
});

function hangUntilAborted(signal: AbortSignal) {
  return new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("startCoreStatusPolling", () => {
  it("asks the configured core, not the page's origin", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json(healthy));
    const statuses: CoreStatus[] = [];
    const { stop } = startCoreStatusPolling((status) => statuses.push(status));

    await vi.waitFor(() =>
      expect(statuses).toEqual([{ state: "online", version: "test" }]),
    );
    expect(fetch.mock.calls[0]?.[0]).toBe("http://core.test:4100/api/health");
    stop();
  });

  it("times out, recovers, and cancels on cleanup", async () => {
    vi.useFakeTimers();
    const statuses: CoreStatus[] = [];
    const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, options) => {
      const signal = options?.signal as AbortSignal;
      signals.push(signal);
      return signals.length === 2
        ? Promise.resolve(Response.json(healthy))
        : hangUntilAborted(signal);
    });

    const { stop } = startCoreStatusPolling((status) => statuses.push(status));
    expect(signals).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(signals[0]?.aborted).toBe(true);
    expect(statuses).toEqual([{ state: "offline" }]);

    // A core that is away is asked again soon.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(statuses.at(-1)).toEqual({ state: "online", version: "test" });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(signals).toHaveLength(3);

    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(signals[2]?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(signals).toHaveLength(3);
    expect(statuses).toHaveLength(2);
  });

  it("never overlaps a slow response with the next poll", async () => {
    vi.useFakeTimers();
    let resolveResponse!: (response: Response) => void;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );

    const { stop } = startCoreStatusPolling(() => {});
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveResponse(Response.json(healthy));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetch).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("says a core waiting for its update to commit is updating", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ ...healthy, version: "dev-2", updatePending: true }),
    );
    const statuses: CoreStatus[] = [];
    const { stop } = startCoreStatusPolling((status) => statuses.push(status));

    await vi.waitFor(() =>
      expect(statuses).toEqual([{ state: "updating", version: "dev-2" }]),
    );
    stop();
  });

  it("asks again at once when told, but never twice at the same time", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json(healthy));
    const { stop, checkNow } = startCoreStatusPolling(() => {});
    checkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    checkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);

    // The next regular check counts from the last one.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    stop();
  });

  it.each([
    null,
    { service: "manager", status: "ok", version: "test" },
    { service: "core", status: "error", version: "test" },
    { service: "core", status: "ok", version: {} },
  ])("treats an invalid health response as offline: %j", async (body) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(body),
    );
    const statuses: CoreStatus[] = [];
    const { stop } = startCoreStatusPolling((status) => statuses.push(status));

    await vi.waitFor(() => expect(statuses).toEqual([{ state: "offline" }]));
    stop();
  });
});
