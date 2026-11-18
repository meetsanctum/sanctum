import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRoomWaits } from "../src/app-host/room-waits.js";

// Updates that wait for room are tried again every minute, once started,
// one try at a time, until the core stops.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("trying updates that wait for room again", () => {
  it("tries every minute once started, and never after closing", async () => {
    const retry = vi.fn(async () => undefined);
    const waits = createRoomWaits({ retry, log: () => undefined });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(retry).not.toHaveBeenCalled();

    waits.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(retry).toHaveBeenCalledTimes(2);

    await waits.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("waits for a try under way, and its close waits for it too", async () => {
    let finish!: () => void;
    const retry = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const waits = createRoomWaits({ retry, log: () => undefined });
    waits.start();

    await vi.advanceTimersByTimeAsync(180_000);
    expect(retry).toHaveBeenCalledTimes(1);

    let closed = false;
    const closing = waits.close().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(closed).toBe(true);
  });
});
