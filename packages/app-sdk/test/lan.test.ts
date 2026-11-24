import { describe, expect, it } from "vitest";

import {
  assertLanPermissions,
  defineApp,
  isMalformedLan,
  lanPermission,
  lanRange,
  lanRanges,
  lanRangesWithin,
  mergedLanRanges,
  permissionWords,
  type AppDefinition,
} from "../src/index.js";

// Reaching the devices an app finds, on one TCP port or a range of them:
// asked for by permission, worded for the household, and only for an app
// that looks.

function reacher(permissions: AppDefinition["permissions"]) {
  return defineApp({
    id: "sanctum.example",
    name: "Example",
    version: "0.1.0",
    core: "^2.0.0",
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
    expect(lanRange("lan:tcp:6053")).toEqual({ from: 6053, to: 6053 });
    expect(lanRange("lan:tcp:65536")).toBeNull();
    expect(lanRange("lan:tcp:0")).toBeNull();
    expect(lanRange("lan:tcp:06053")).toBeNull();
    expect(lanRange("lan:udp:6053")).toBeNull();
    expect(lanRange("net:example.com")).toBeNull();
    expect(isMalformedLan("lan:tcp:http")).toBe(true);
    expect(isMalformedLan("lan:tcp:80")).toBe(false);
    expect(
      lanRanges([
        "lan:tcp:8080",
        "lan:tcp:6053",
        "lan:tcp:8080",
        "places.read",
      ]),
    ).toEqual([
      { from: 6053, to: 6053 },
      { from: 8080, to: 8080 },
    ]);
    expect(permissionWords("lan:tcp:6053")).toEqual({
      title: "Talk to devices on your network",
      detail: "Port 6053, to the devices it found",
      icon: "network",
    });
  });

  it("names a range of the ports devices hand out for a session", () => {
    expect(lanPermission(49_152, 65_535)).toBe("lan:tcp:49152-65535");
    expect(lanRange("lan:tcp:49152-65535")).toEqual({
      from: 49_152,
      to: 65_535,
    });
    expect(lanRange("lan:tcp:50000-50010")).toEqual({
      from: 50_000,
      to: 50_010,
    });
    for (const malformed of [
      // Not upwards, or no wider than one port.
      "lan:tcp:50010-50000",
      "lan:tcp:50000-50000",
      // Outside the ports handed out for a session.
      "lan:tcp:1-65535",
      "lan:tcp:1024-65535",
      "lan:tcp:49151-50000",
      "lan:tcp:49152-65536",
      // Written any other way.
      "lan:tcp:49152-",
      "lan:tcp:-65535",
      "lan:tcp:49152-60000-65535",
      "lan:tcp:049152-65535",
      "lan:tcp:49152 - 65535",
    ]) {
      expect(lanRange(malformed), malformed).toBeNull();
      expect(isMalformedLan(malformed), malformed).toBe(true);
    }
    expect(permissionWords("lan:tcp:49152-65535")).toEqual({
      title: "Talk to devices on your network",
      detail: "Any port from 49152 to 65535, on the devices it found",
      icon: "network",
    });
  });

  it("compares ports by the ports they cover", () => {
    expect(
      mergedLanRanges([
        { from: 50_011, to: 50_020 },
        { from: 7000, to: 7000 },
        { from: 50_000, to: 50_010 },
        { from: 7001, to: 7001 },
        { from: 50_015, to: 50_030 },
      ]),
    ).toEqual([
      { from: 7000, to: 7001 },
      { from: 50_000, to: 50_030 },
    ]);
    const outer = [
      { from: 7000, to: 7000 },
      { from: 50_000, to: 50_010 },
      { from: 50_011, to: 50_020 },
    ];
    expect(lanRangesWithin([{ from: 50_005, to: 50_015 }], outer)).toBe(true);
    expect(lanRangesWithin([{ from: 7000, to: 7000 }], outer)).toBe(true);
    expect(lanRangesWithin([], outer)).toBe(true);
    // One port past either end is outside.
    expect(lanRangesWithin([{ from: 49_999, to: 50_005 }], outer)).toBe(false);
    expect(lanRangesWithin([{ from: 50_015, to: 50_021 }], outer)).toBe(false);
    expect(lanRangesWithin([{ from: 7001, to: 7001 }], outer)).toBe(false);
  });

  it("refuses ports that switching one off wouldn't take away", () => {
    expect(() =>
      assertLanPermissions([
        "discover:mdns:_example._tcp",
        "lan:tcp:7000",
        "lan:tcp:7001",
        "lan:tcp:49152-50000",
        "lan:tcp:50001-65535",
      ]),
    ).not.toThrow();
    expect(() =>
      assertLanPermissions([
        "discover:mdns:_example._tcp",
        "lan:tcp:50000",
        "lan:tcp:49152-65535",
      ]),
    ).toThrow("lan:tcp:49152-65535 and lan:tcp:50000 share ports");
    expect(() =>
      assertLanPermissions([
        "discover:mdns:_example._tcp",
        "lan:tcp:49152-50010",
        "lan:tcp:50010-65535",
      ]),
    ).toThrow("share ports");
  });

  it("asks for at most 16 ports and ranges", () => {
    const ports = (count: number) =>
      Array.from({ length: count }, (_, index) => `lan:tcp:${7000 + index}`);
    expect(() =>
      assertLanPermissions(["discover:mdns:_example._tcp", ...ports(16)]),
    ).not.toThrow();
    expect(() =>
      assertLanPermissions([
        "discover:mdns:_example._tcp",
        ...ports(15),
        "lan:tcp:49152-65535",
      ]),
    ).not.toThrow();
    expect(() =>
      assertLanPermissions(["discover:mdns:_example._tcp", ...ports(17)]),
    ).toThrow("at most 16");
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
    expect(() =>
      reacher([
        { id: "discover:mdns:_example._tcp", reason: "For the test." },
        { id: "lan:tcp:7000", reason: "For the test." },
        { id: "lan:tcp:49152-65535", reason: "For the test." },
      ]),
    ).not.toThrow();
    expect(() =>
      reacher([{ id: "lan:tcp:49152-65535", reason: "For the test." }]),
    ).toThrow("needs a discover:mdns: permission");
  });
});
