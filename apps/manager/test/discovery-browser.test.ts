import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { transport } = vi.hoisted(() => ({
  transport: { current: undefined as unknown },
}));

// Keep bonjour-service's real parser and cache, replacing only its UDP socket.
vi.mock("bonjour-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bonjour-service")>();
  return {
    ...actual,
    Bonjour: class {
      find(options: { type: string; protocol: "tcp" | "udp" }) {
        return new actual.Browser(transport.current, options);
      }
      destroy() {}
    },
  };
});

import { createDiscovery, type Discovery } from "../src/discovery.js";

const service = "_example._tcp";
const instance = `kitchen.${service}.local`;
const networks = {
  home: [{ address: "192.168.1.10", netmask: "255.255.255.0" }],
  own: ["192.168.1.10"],
  virtual: [],
};

function response(address: string) {
  return {
    answers: [
      { name: `${service}.local`, type: "PTR", ttl: 4_500, data: instance },
    ],
    additionals: [
      {
        name: instance,
        type: "SRV",
        ttl: 120,
        data: { target: "kitchen.local", port: 8080 },
      },
      {
        name: instance,
        type: "TXT",
        ttl: 4_500,
        data: [Buffer.from("id=kitchen")],
      },
      { name: "kitchen.local", type: "A", ttl: 120, data: address },
    ],
  };
}

describe("browsing with bonjour-service", () => {
  let discovery: Discovery | undefined;
  afterEach(() => {
    discovery?.close();
    vi.useRealTimers();
  });

  function setUp() {
    vi.useFakeTimers();
    const mdns = Object.assign(new EventEmitter(), { query: vi.fn() });
    transport.current = mdns;
    discovery = createDiscovery({ networks: () => networks, waitMs: 0 });
    return mdns;
  }

  it("refreshes addresses even when a device's SRV and TXT stay the same", async () => {
    const mdns = setUp();
    const first = await discovery!.poll(null, [service]);
    mdns.emit("response", response("192.168.1.40"), {});
    await vi.advanceTimersByTimeAsync(250);
    const found = await discovery!.poll(first.after, [service]);
    expect(found.found[0]?.addresses).toEqual(["192.168.1.40"]);

    await vi.advanceTimersByTimeAsync(60_000);
    mdns.emit("response", response("192.168.1.41"), {});
    await vi.advanceTimersByTimeAsync(250);
    const moved = await discovery!.poll(found.after, [service]);
    expect(moved.found[0]?.addresses).toEqual(["192.168.1.41"]);
    expect(mdns.listenerCount("response")).toBe(1);
  });

  it("loses an unanswered sighting after ten minutes even with a longer DNS TTL", async () => {
    const mdns = setUp();
    const first = await discovery!.poll(null, [service]);
    mdns.emit("response", response("192.168.1.40"), {});
    await vi.advanceTimersByTimeAsync(250);
    const found = await discovery!.poll(first.after, [service]);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await discovery!.poll(found.after, [service])).toMatchObject({
      found: [],
      lost: [{ service, name: "kitchen" }],
    });
  });

  it("keeps a device that answers each round past the original DNS TTL", async () => {
    const mdns = setUp();
    await discovery!.poll(null, [service]);
    for (let round = 0; round < 80; round += 1) {
      mdns.emit("response", response("192.168.1.40"), {});
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(await discovery!.poll(null, [service])).toMatchObject({
      found: [{ name: "kitchen", addresses: ["192.168.1.40"] }],
      lost: [],
    });
    expect(mdns.listenerCount("response")).toBe(1);
  });
});
