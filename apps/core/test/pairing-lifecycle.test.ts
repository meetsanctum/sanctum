import type { Actor } from "@meetsanctum/app-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPairing, type PairingDrivers } from "../src/devices/pairing.js";

const actor: Actor = { kind: "user", id: "admin" };
const who = { personId: "admin", clientId: "phone" };
function pendingReply<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const now = new Date("2026-10-29T12:00:00Z");

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const drivers: PairingDrivers = {
    list: () => ["radio"],
    open: vi.fn(async (_driver, seconds) => ({
      until: new Date(Date.now() + seconds * 1000).toISOString(),
    })),
    close: vi.fn(async () => {}),
  };
  const record = vi.fn();
  const deviceId = vi.fn((): string | null => null);
  const pairing = createPairing({ drivers, record, deviceId, log: vi.fn() });
  return { pairing, drivers, record, deviceId };
}

afterEach(() => vi.useRealTimers());

describe("pairing lifecycle", () => {
  it("shows a repeated join in the new session with its current identity", async () => {
    const { pairing, deviceId } = setup();
    await pairing.open(actor, who, {});
    pairing.joining("radio", { key: "lamp", stage: "joined" });
    deviceId.mockReturnValue("old-id");
    pairing.joining("radio", { key: "lamp", stage: "ready" });
    await pairing.close(actor, who);
    vi.advanceTimersByTime(1000);
    const opened = await pairing.open(actor, who, {});
    pairing.joining("radio", { key: "lamp", stage: "joined" });
    // It joins again as itself, so it is that device from the start.
    expect(pairing.info().joined[0]).toMatchObject({
      joinedAt: opened.since,
      known: true,
      deviceId: "old-id",
      stage: "joined",
    });
    // Removal and another join must not retain the old registry id.
    deviceId.mockReturnValue(null);
    pairing.joining("radio", { key: "lamp", stage: "joined" });
    expect(pairing.info().joined[0]).toMatchObject({
      known: false,
      deviceId: null,
    });
  });

  it("drops the device of a known join once the core removes it", async () => {
    const { pairing, deviceId } = setup();
    deviceId.mockReturnValue("old-id");
    await pairing.open(actor, who, {});
    pairing.joining("radio", { key: "lamp", stage: "joined" });

    // Removed while it is being set up again.
    deviceId.mockReturnValue(null);
    pairing.joining("radio", { key: "lamp", stage: "interviewing" });

    expect(pairing.info().joined[0]).toMatchObject({
      stage: "interviewing",
      deviceId: null,
    });
  });

  it("records devices that join while a driver is still answering open", async () => {
    const { pairing, drivers } = setup();
    vi.mocked(drivers.open).mockImplementation(async () => {
      pairing.joining("radio", { key: "lamp", stage: "joined" });
      return { until: new Date(Date.now() + 60_000).toISOString() };
    });
    await pairing.open(actor, who, {});
    expect(pairing.info().joined).toHaveLength(1);
  });

  it("waits for opening before closing the same network", async () => {
    const { pairing, drivers } = setup();
    const answer = pendingReply<{ until: string }>();
    vi.mocked(drivers.open).mockReturnValue(answer.promise);
    const opened = pairing.open(actor, who, {});
    await Promise.resolve();
    const closed = pairing.close(actor, who);
    await Promise.resolve();
    expect(drivers.close).not.toHaveBeenCalled();
    answer.resolve({ until: new Date(Date.now() + 60_000).toISOString() });
    await opened;
    await closed;
    expect(pairing.info().until).toBeNull();
  });

  it("reports a failed close and keeps the network's deadline until a retry succeeds", async () => {
    const { pairing, drivers, record } = setup();
    const opened = await pairing.open(actor, who, {});
    vi.mocked(drivers.close).mockRejectedValueOnce(new Error("disconnected"));
    await expect(pairing.close(actor, who)).rejects.toMatchObject({
      code: "app_failed",
    });
    expect(pairing.info().until).toBe(opened.until);
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "pairing.close",
        outcome: "failed",
      }),
    );
    await pairing.close(actor, who);
    expect(pairing.info().until).toBeNull();
  });

  it("tracks only the driver whose network is open", async () => {
    const { pairing } = setup();
    await pairing.open(actor, who, {});
    pairing.joining("another-radio", { key: "lamp", stage: "joined" });
    expect(pairing.info().joined).toEqual([]);
  });

  it("keeps a renewed deadline when the previous window expires while another driver answers", async () => {
    const { pairing, drivers } = setup();
    await pairing.open(actor, who, { seconds: 1 });
    drivers.list = () => ["radio", "slow-radio"];
    const answer = pendingReply<{ until: string | null }>();
    vi.mocked(drivers.open).mockImplementation(async (driver) =>
      driver === "radio"
        ? { until: new Date(Date.now() + 60_000).toISOString() }
        : answer.promise,
    );
    const reopened = pairing.open(actor, who, {});
    await vi.advanceTimersByTimeAsync(1000);
    answer.resolve({ until: null });
    await reopened;
    expect(pairing.info().until).toBe("2026-10-29T12:01:00.000Z");
  });

  it("keeps only the deadline of the network that failed to close", async () => {
    const { pairing, drivers } = setup();
    drivers.list = () => ["radio", "other-radio"];
    vi.mocked(drivers.open).mockImplementation(async (driver) => ({
      until: new Date(
        Date.now() + (driver === "radio" ? 60_000 : 120_000),
      ).toISOString(),
    }));
    await pairing.open(actor, who, {});
    vi.mocked(drivers.close).mockImplementation(async (driver) => {
      if (driver === "radio") throw new Error("disconnected");
    });
    await expect(pairing.close(actor, who)).rejects.toMatchObject({
      code: "app_failed",
    });
    expect(pairing.info().until).toBe("2026-10-29T12:01:00.000Z");
    pairing.joining("other-radio", { key: "lamp", stage: "joined" });
    expect(pairing.info().joined).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pairing.info().until).toBeNull();
  });

  it("rejects an invalid deadline without leaving broken state", async () => {
    const { pairing, drivers } = setup();
    vi.mocked(drivers.open).mockResolvedValue({ until: "invalid" });
    await expect(pairing.open(actor, who, {})).rejects.toMatchObject({
      code: "app_failed",
    });
    expect(pairing.info().until).toBeNull();
  });

  it("expires old entries on reads and holds at most 64 devices", async () => {
    const { pairing } = setup();
    await pairing.open(actor, who, {});
    for (let index = 0; index < 65; index++) {
      pairing.joining("radio", { key: `lamp-${index}`, stage: "joined" });
    }
    expect(pairing.info().joined).toHaveLength(64);
    vi.advanceTimersByTime(60 * 60_000);
    expect(pairing.info().joined).toEqual([]);
  });
});
