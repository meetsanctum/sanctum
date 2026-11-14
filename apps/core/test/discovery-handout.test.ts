import { type DriverDiscovery, type Sighting } from "@meetsanctum/app-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDiscoveryHandOut } from "../src/app-host/discovered.js";
import type { InstalledApp } from "../src/app-host/installed.js";

const kitchen: Sighting = {
  service: "_example._tcp",
  name: "kitchen",
  host: "kitchen.local",
  addresses: ["192.168.1.40"],
  port: 8080,
  txt: {},
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setUp(
  discovered: (id: string, input: DriverDiscovery) => Promise<void>,
) {
  const entry = {
    app: { id: "sanctum.example" },
    manifest: { driver: { hooks: ["discovered"] } },
    granted: ["discover:mdns:_example._tcp"],
    runId: 1,
  } as unknown as InstalledApp;
  let sightings = [kitchen];
  const handOut = createDiscoveryHandOut({
    installed: new Map([[entry.app.id, entry]]),
    accepts: () => true,
    sightings: () => sightings,
    discovered,
    log: () => undefined,
    againMs: 30,
  });
  return {
    entry,
    handOut,
    setSightings: (next: Sighting[]) => {
      sightings = next;
    },
  };
}

describe("handing sightings to a driver", () => {
  afterEach(() => vi.useRealTimers());

  it("checks permission again before a queued delivery starts", async () => {
    const discovered = vi.fn(async () => undefined);
    const { entry, handOut } = setUp(discovered);
    handOut.sync();
    entry.granted = [];
    await Promise.resolve();
    await Promise.resolve();
    expect(discovered).not.toHaveBeenCalled();
    handOut.close();
  });

  it("takes changes in order after the active delivery ends", async () => {
    const pending = deferred();
    const discovered = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(undefined);
    const { handOut, setSightings } = setUp(discovered);
    handOut.sync();
    await Promise.resolve();
    setSightings([]);
    handOut.sync();
    expect(discovered).toHaveBeenCalledTimes(1);
    pending.resolve();
    await vi.waitFor(() => expect(discovered).toHaveBeenCalledTimes(2));
    expect(discovered.mock.calls[1]![1]).toEqual({
      found: [],
      lost: [{ service: kitchen.service, name: kitchen.name }],
    });
    handOut.close();
  });

  it("doesn't deliver queued sightings after permission is revoked", async () => {
    const pending = deferred();
    const discovered = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(undefined);
    const { entry, handOut, setSightings } = setUp(discovered);
    handOut.sync();
    await Promise.resolve();
    setSightings([{ ...kitchen, addresses: ["192.168.1.41"] }]);
    handOut.sync();
    entry.granted = [];
    handOut.sync();
    pending.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(discovered).toHaveBeenCalledTimes(1);
    handOut.close();
  });

  it("a failed delivery from an earlier run doesn't reset the current run", async () => {
    const pending = deferred();
    const discovered = vi
      .fn()
      .mockImplementationOnce(async () => {
        await pending.promise;
        throw new Error("old run");
      })
      .mockResolvedValue(undefined);
    const { entry, handOut } = setUp(discovered);
    handOut.sync();
    await Promise.resolve();
    entry.runId += 1;
    handOut.sync();
    pending.resolve();
    await vi.waitFor(() => expect(discovered).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discovered).toHaveBeenCalledTimes(2);
    handOut.close();
  });

  it("a permission granted again waits for the active delivery to end", async () => {
    const pending = deferred();
    const discovered = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(undefined);
    const { entry, handOut } = setUp(discovered);
    handOut.sync();
    await Promise.resolve();
    entry.granted = [];
    handOut.sync();
    entry.granted = ["discover:mdns:_example._tcp"];
    handOut.sync();
    await Promise.resolve();
    expect(discovered).toHaveBeenCalledTimes(1);
    pending.resolve();
    await vi.waitFor(() => expect(discovered).toHaveBeenCalledTimes(2));
    handOut.close();
  });

  it("retries lost sightings even if the failed hook partly applied them", async () => {
    vi.useFakeTimers();
    const discovered = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValue(undefined);
    const { handOut, setSightings } = setUp(discovered);
    handOut.sync();
    await vi.advanceTimersByTimeAsync(0);
    setSightings([]);
    handOut.sync();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30);
    expect(discovered).toHaveBeenCalledTimes(3);
    expect(discovered.mock.calls[2]![1]).toEqual({
      found: [],
      lost: [{ service: kitchen.service, name: kitchen.name }],
    });
    handOut.close();
  });

  it("doesn't start a retry after closing while a call fails", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const discovered = vi.fn(async () => {
      await pending.promise;
      throw new Error("failed");
    });
    const { handOut } = setUp(discovered);
    handOut.sync();
    await Promise.resolve();
    handOut.close();
    pending.resolve();
    await vi.advanceTimersByTimeAsync(60);
    expect(discovered).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
