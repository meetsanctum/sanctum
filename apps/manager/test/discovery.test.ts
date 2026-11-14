import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDiscovery,
  isHomeAddress,
  type FoundService,
  type HostNetworks,
  type ServiceBrowser,
} from "../src/discovery.js";
import { createServer } from "../src/server.js";

// Finding devices on the home's network for the apps that look for them,
// with a pretend network: only addresses of devices on the home's own
// network are handed on, and the core asks for what changed.

const networks: HostNetworks = {
  home: [{ address: "192.168.1.10", netmask: "255.255.255.0" }],
  own: ["192.168.1.10", "172.17.0.1", "127.0.0.1"],
  virtual: [{ address: "172.17.0.1", netmask: "255.255.0.0" }],
};

describe("an address handed to an app", () => {
  it.each([
    ["a device on the home's network", "192.168.1.40", true],
    ["the host itself", "192.168.1.10", false],
    ["the subnet's own address", "192.168.1.0", false],
    ["the subnet's broadcast", "192.168.1.255", false],
    ["another network", "192.168.2.40", false],
    ["a container", "172.17.0.5", false],
    ["loopback", "127.0.0.1", false],
    ["link-local", "169.254.1.1", false],
    ["multicast", "224.0.0.251", false],
    ["the limited broadcast", "255.255.255.255", false],
    ["no IPv4 at all", "fe80::1", false],
  ])("is %s: %s", (_what, address, home) => {
    expect(isHomeAddress(address, networks)).toBe(home);
  });
});

class PretendBrowser extends EventEmitter implements ServiceBrowser {
  services: FoundService[] = [];
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

const kitchen: FoundService = {
  lastSeen: 0,
  name: "kitchen-sensor",
  host: "kitchen-sensor.local",
  port: 8080,
  addresses: ["fe80::1", "192.168.1.40", "172.17.0.5"],
  txt: { mac: "aabbccddeeff", ready: true },
};

describe("finding devices", () => {
  const closing: { close(): void }[] = [];
  afterEach(() => {
    for (const each of closing.splice(0)) each.close();
  });

  function pretend() {
    const browsers = new Map<string, PretendBrowser>();
    const hostNetworks = structuredClone(networks);
    let clock = 0;
    const discovery = createDiscovery({
      networks: () => hostNetworks,
      now: () => clock,
      waitMs: 50,
      browsing: () => ({
        browse(type, protocol) {
          const browser = new PretendBrowser();
          browsers.set(`_${type}._${protocol}`, browser);
          return browser;
        },
        destroy() {},
      }),
    });
    closing.push(discovery);
    return {
      discovery,
      browsers,
      networks: hostNetworks,
      advance: (ms: number) => (clock += ms),
    };
  }

  it("keeps a device with only its home address, and hands every one afresh", async () => {
    const { discovery, browsers } = pretend();
    const first = await discovery.poll(null, ["_example._tcp"]);
    expect(first).toMatchObject({ full: true, found: [], lost: [] });

    browsers.get("_example._tcp")!.services = [kitchen];
    discovery.take();
    const found = await discovery.poll(first.after, ["_example._tcp"]);

    expect(found).toEqual({
      after: expect.any(String),
      full: false,
      found: [
        {
          service: "_example._tcp",
          name: "kitchen-sensor",
          host: "kitchen-sensor.local",
          addresses: ["192.168.1.40"],
          port: 8080,
          txt: { mac: "aabbccddeeff", ready: "" },
        },
      ],
      lost: [],
    });
    // Another run's place, or none, is answered with everything.
    const afresh = await discovery.poll("another:3", ["_example._tcp"]);
    expect(afresh).toMatchObject({
      full: true,
      found: [{ name: "kitchen-sensor" }],
    });
  });

  it("hands on no device that has no address an app may reach", async () => {
    const { discovery, browsers } = pretend();
    const first = await discovery.poll(null, ["_example._tcp"]);
    browsers.get("_example._tcp")!.services = [
      { ...kitchen, addresses: ["192.168.1.10", "172.17.0.5"] },
    ];
    discovery.take();

    expect(await discovery.poll(first.after, ["_example._tcp"])).toMatchObject({
      found: [],
      lost: [],
    });
  });

  it("loses a device not seen for 10 minutes", async () => {
    const { discovery, browsers, advance } = pretend();
    const first = await discovery.poll(null, ["_example._tcp"]);
    const browser = browsers.get("_example._tcp")!;
    browser.services = [kitchen];
    discovery.take();
    const found = await discovery.poll(first.after, ["_example._tcp"]);

    browser.services = [];
    advance(9 * 60_000);
    discovery.take();
    const still = await discovery.poll(found.after, ["_example._tcp"]);
    expect(still).toMatchObject({ found: [], lost: [] });

    advance(60_000);
    discovery.take();
    expect(await discovery.poll(still.after, ["_example._tcp"])).toMatchObject({
      found: [],
      lost: [{ service: "_example._tcp", name: "kitchen-sensor" }],
    });
  });

  it("doesn't count a cached service as another network response", async () => {
    const { discovery, browsers, advance } = pretend();
    const first = await discovery.poll(null, ["_example._tcp"]);
    browsers.get("_example._tcp")!.services = [kitchen];
    discovery.take();
    const found = await discovery.poll(first.after, ["_example._tcp"]);

    advance(9 * 60_000);
    discovery.take();
    advance(60_000);
    discovery.take();

    expect(await discovery.poll(found.after, ["_example._tcp"])).toMatchObject({
      found: [],
      lost: [{ service: "_example._tcp", name: kitchen.name }],
    });
  });

  it("loses a sighting as soon as its address becomes the host's own", async () => {
    const { discovery, browsers } = pretend();
    const first = await discovery.poll(null, ["_example._tcp"]);
    const browser = browsers.get("_example._tcp")!;
    browser.services = [kitchen];
    discovery.take();
    const found = await discovery.poll(first.after, ["_example._tcp"]);
    browser.services = [{ ...kitchen, addresses: ["192.168.1.10"] }];
    discovery.take();

    expect(await discovery.poll(found.after, ["_example._tcp"])).toMatchObject({
      found: [],
      lost: [{ service: "_example._tcp", name: kitchen.name }],
    });
  });

  it("removes cached addresses when the host's networks change", async () => {
    const { discovery, browsers, networks } = pretend();
    const first = await discovery.poll(null, ["_example._tcp"]);
    const browser = browsers.get("_example._tcp")!;
    browser.services = [kitchen];
    discovery.take();
    const found = await discovery.poll(first.after, ["_example._tcp"]);
    browser.services = [];
    networks.own.push("192.168.1.40");
    discovery.take();

    expect(await discovery.poll(found.after, ["_example._tcp"])).toMatchObject({
      found: [],
      lost: [{ service: "_example._tcp", name: kitchen.name }],
    });
  });

  it("waits for news, and answers as soon as there is some", async () => {
    const { discovery, browsers } = pretend();
    const first = await discovery.poll(null, ["_example._tcp"]);
    const waiting = discovery.poll(first.after, ["_example._tcp"]);
    browsers.get("_example._tcp")!.services = [kitchen];
    discovery.take();

    expect((await waiting).found).toHaveLength(1);
  });

  it("stops looking for a service no longer asked for, losing what it found", async () => {
    const { discovery, browsers } = pretend();
    const first = await discovery.poll(null, ["_example._tcp"]);
    const browser = browsers.get("_example._tcp")!;
    browser.services = [kitchen];
    discovery.take();
    const found = await discovery.poll(first.after, ["_example._tcp"]);

    const after = await discovery.poll(found.after, []);

    expect(browser.stopped).toBe(true);
    expect(after.lost).toEqual([
      { service: "_example._tcp", name: "kitchen-sensor" },
    ]);
  });
});

describe("GET /api/discovery", () => {
  it("answers the core's question, and says the manager looks", async () => {
    const asked: [string | null, readonly string[]][] = [];
    const server = createServer(
      { version: "dev-test" },
      {
        discovery: {
          poll: async (after, services) => {
            asked.push([after, services]);
            return { after: "run:1", full: true, found: [], lost: [] };
          },
        },
      },
    );

    const answer = await server.inject(
      "/api/discovery?after=run%3A0&services=_example._tcp,_other._udp",
    );
    const capabilities = await server.inject("/api/capabilities");

    expect(answer.statusCode).toBe(200);
    expect(asked).toEqual([["run:0", ["_example._tcp", "_other._udp"]]]);
    expect(capabilities.json()).toMatchObject({ discovery: true });
  });

  it("refuses a service that isn't one, and says when it doesn't look", async () => {
    const looking = createServer(
      { version: "dev-test" },
      {
        discovery: {
          poll: async () => ({
            after: "run:1",
            full: true,
            found: [],
            lost: [],
          }),
        },
      },
    );
    const none = createServer({ version: "dev-test" });

    expect(
      (await looking.inject("/api/discovery?services=example")).statusCode,
    ).toBe(400);
    expect((await none.inject("/api/discovery")).statusCode).toBe(503);
    expect((await none.inject("/api/capabilities")).json()).toMatchObject({
      discovery: false,
    });
  });
});
