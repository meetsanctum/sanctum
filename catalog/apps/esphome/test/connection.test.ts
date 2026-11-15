import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Socket } from "node:net";

import {
  connectOnce,
  createConnection,
  type Connection,
  type ConnectionEvents,
} from "../src/connection.js";
import { EmulatedDevice, newKey } from "./emulated-device.js";
import { entitiesOf, keyOf, nextMac, timings } from "./support.js";

// A device's connection where it can go wrong: a session that closes before
// it's taken over, a setup the driver couldn't finish, a connection gone
// quiet, a key that can't be read, and a handshake still under way as the
// app stops.

let device: EmulatedDevice;
let connection: Connection;

function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  device = await EmulatedDevice.start({
    name: "lamp",
    mac: nextMac(),
    psk: newKey(),
    ...entitiesOf("light"),
  });
});

afterEach(async () => {
  connection?.stop();
  await device.stop();
  vi.useRealTimers();
});

function connect(
  key: () => Promise<string | null>,
  events: Partial<ConnectionEvents> = {},
  clock = timings,
) {
  connection = createConnection({
    mac: keyOf(device.options.mac),
    key,
    address: () => ({ host: device.host, port: device.port }),
    timings: clock,
    events: {
      connected: async () => {},
      state() {},
      reachable() {},
      halted() {},
      ...events,
    },
  });
  connection.start();
  return connection;
}

describe("a device's connection", () => {
  it("reconnects when an added session closed before it could be adopted", async () => {
    const checked = await connectOnce({
      mac: keyOf(device.options.mac),
      key: device.psk,
      address: { host: device.host, port: device.port },
      timings,
    });
    if (!("session" in checked)) throw new Error("The device did not connect");
    checked.session.client.disconnect();
    const connected = vi.fn(async () => {});
    connect(async () => device.psk, { connected });

    connection.adopt(checked.session);

    await expect.poll(() => device.connections).toBe(2);
    await expect.poll(() => connected.mock.calls.length).toBe(1);
    expect(connection.session?.encrypted).toBe(true);
  });

  it.each(["repair", "announcement"])(
    "connects with the new key after a %s during a pending attempt",
    async (reason) => {
      const reading = defer<string | null>();
      const key = vi
        .fn<() => Promise<string | null>>()
        .mockReturnValueOnce(reading.promise)
        .mockResolvedValue(device.psk);
      const connected = vi.fn(async () => {});
      connect(key, { connected });

      if (reason === "repair") connection.renew();
      else connection.seen(true);
      reading.resolve(newKey());

      await expect.poll(() => connected.mock.calls.length).toBe(1);
      expect(key).toHaveBeenCalledTimes(2);
      expect(connection.session?.encrypted).toBe(true);
    },
  );

  it("retries setup before reporting reachability or forwarding states", async () => {
    const connected = vi
      .fn<ConnectionEvents["connected"]>()
      .mockRejectedValueOnce(new Error("The registration failed"))
      .mockImplementationOnce(async () => {
        expect(reachable).not.toHaveBeenCalled();
        expect(state).not.toHaveBeenCalled();
      });
    const reachable = vi.fn();
    const state = vi.fn();
    connect(async () => device.psk, { connected, reachable, state });

    await expect.poll(() => state.mock.calls.length).toBeGreaterThan(0);

    expect(connected).toHaveBeenCalledTimes(2);
    expect(reachable.mock.calls).toEqual([[true]]);
    expect(device.connections).toBe(2);
  });

  it("marks a silent connection unreachable when its heartbeat expires", async () => {
    vi.useFakeTimers();
    device.answersPings = false;
    const ready = defer<void>();
    const reported = defer<void>();
    const reachable = vi.fn();
    connect(
      async () => device.psk,
      {
        connected: async () => ready.resolve(),
        state: () => reported.resolve(),
        reachable,
      },
      { ...timings, pingMs: 1_000, offlineMs: 3_000 },
    );
    await ready.promise;
    await reported.promise;
    expect(reachable.mock.calls).toEqual([[true]]);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(reachable.mock.calls).toEqual([[true], [false]]);
  });

  it("retries a failed key read without an unhandled rejection", async () => {
    const key = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("The core did not answer"))
      .mockResolvedValue(device.psk);
    const connected = vi.fn(async () => {});
    connect(key, { connected });

    await expect.poll(() => connected.mock.calls.length).toBe(1);
    expect(key).toHaveBeenCalledTimes(2);
    expect(connection.session?.encrypted).toBe(true);
  });

  it("closes an unfinished handshake when stopped", async () => {
    const accepted = defer<void>();
    let peer: Socket | undefined;
    let closed = false;
    const server = createServer((socket) => {
      peer = socket;
      socket.resume();
      socket.on("close", () => {
        closed = true;
      });
      accepted.resolve();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    try {
      connection = createConnection({
        mac: keyOf(device.options.mac),
        key: async () => device.psk,
        address: () => ({ host: "127.0.0.1", port: address.port }),
        timings,
        events: {
          connected: async () => {},
          state() {},
          reachable() {},
          halted() {},
        },
      });
      connection.start();
      await accepted.promise;

      connection.stop();

      await expect.poll(() => closed, { timeout: 300 }).toBe(true);
    } finally {
      peer?.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
