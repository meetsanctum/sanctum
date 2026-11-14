import { describe, expect, it } from "vitest";

import {
  defineApp,
  isMalformedLan,
  lanPermission,
  lanPort,
  lanPorts,
  permissionWords,
  type AppDefinition,
} from "../src/index.js";

// Reaching the devices an app finds, on one TCP port: asked for by
// permission, worded for the household, and only for an app that looks.

function reacher(permissions: AppDefinition["permissions"]) {
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
    driver: {
      command: async () => undefined,
      ...(permissions.some((each) => each.id.startsWith("discover:"))
        ? { discovered: async () => undefined }
        : {}),
    },
  });
}

describe("reaching devices on the network", () => {
  it("names the port it reaches its devices on, worded for the household", () => {
    expect(lanPermission(6053)).toBe("lan:tcp:6053");
    expect(lanPort("lan:tcp:6053")).toBe(6053);
    expect(lanPort("lan:tcp:65536")).toBeNull();
    expect(lanPort("lan:tcp:0")).toBeNull();
    expect(lanPort("lan:tcp:06053")).toBeNull();
    expect(lanPort("lan:udp:6053")).toBeNull();
    expect(lanPort("net:example.com")).toBeNull();
    expect(isMalformedLan("lan:tcp:http")).toBe(true);
    expect(isMalformedLan("lan:tcp:80")).toBe(false);
    expect(
      lanPorts(["lan:tcp:8080", "lan:tcp:6053", "lan:tcp:8080", "places.read"]),
    ).toEqual([6053, 8080]);
    expect(permissionWords("lan:tcp:6053")).toEqual({
      title: "Talk to devices on your network",
      detail: "Port 6053, to the devices it found",
      icon: "network",
    });
  });

  it("is for an app that finds what it reaches", () => {
    expect(() =>
      reacher([
        { id: "discover:mdns:_example._tcp", reason: "For the test." },
        { id: "lan:tcp:6053", reason: "For the test." },
      ]),
    ).not.toThrow();
    expect(() =>
      reacher([{ id: "lan:tcp:6053", reason: "For the test." }]),
    ).toThrow("needs a discover:mdns: permission");
    expect(() =>
      reacher([
        { id: "discover:mdns:_example._tcp", reason: "For the test." },
        { id: "lan:tcp:any", reason: "For the test." },
      ]),
    ).toThrow("must name a TCP port");
  });
});
