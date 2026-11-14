import { describe, expect, it } from "vitest";

import {
  defineApp,
  discoveredService,
  discoveredServices,
  permissionWords,
  toStaticManifest,
  type AppDefinition,
} from "../src/index.js";

// A driver that looks for a service on the home's network: asked for by
// permission, worded for the household, and heard of through its hook.

function finder(
  permissions: AppDefinition["permissions"],
  driver: Partial<NonNullable<AppDefinition["driver"]>> = {},
) {
  return defineApp({
    id: "sanctum.example",
    name: "Example",
    version: "0.1.0",
    core: "^1.0.0",
    permissions: [
      { id: "devices.register", reason: "For the test." },
      ...permissions,
    ],
    actions: [],
    events: [],
    driver: { command: async () => undefined, ...driver },
  });
}

const discovered = async () => undefined;

describe("looking for devices on the network", () => {
  it("names the service it looks for, worded for the household", () => {
    expect(discoveredService("discover:mdns:_example._tcp")).toBe(
      "_example._tcp",
    );
    expect(discoveredService("discover:mdns:example")).toBeNull();
    expect(discoveredService("net:example.com")).toBeNull();
    expect(
      discoveredServices([
        "discover:mdns:_example._tcp",
        "discover:mdns:_other._udp",
        "discover:mdns:_example._tcp",
        "devices.register",
      ]),
    ).toEqual(["_example._tcp", "_other._udp"]);
    expect(permissionWords("discover:mdns:_example._tcp")).toEqual({
      title: "Find devices on your network",
      detail: null,
      icon: "radar",
    });
  });

  it("has its hook among the driver's in its manifest", () => {
    const app = finder(
      [{ id: "discover:mdns:_example._tcp", reason: "For the test." }],
      { discovered },
    );
    expect(toStaticManifest(app).driver?.hooks).toEqual([
      "command",
      "discovered",
    ]);
  });

  it("refuses discovery from an app that isn't a driver", () => {
    expect(() =>
      defineApp({
        id: "sanctum.example",
        name: "Example",
        version: "0.1.0",
        core: "^1.0.0",
        permissions: [
          { id: "discover:mdns:_example._tcp", reason: "For the test." },
        ],
        actions: [],
        events: [],
        driver: { discovered },
      } as unknown as AppDefinition),
    ).toThrow("Only a driver");
  });

  it.each([
    [
      "a service that isn't one",
      [{ id: "discover:mdns:example", reason: "For the test." }],
      { discovered },
    ],
    [
      "another way of looking",
      [{ id: "discover:ssdp:_example._tcp", reason: "For the test." }],
      { discovered },
    ],
    [
      "looking without the hook",
      [{ id: "discover:mdns:_example._tcp", reason: "For the test." }],
      {},
    ],
    ["the hook without looking", [], { discovered }],
  ])("refuses %s", (_what, permissions, driver) => {
    expect(() => finder(permissions, driver)).toThrow();
  });
});
