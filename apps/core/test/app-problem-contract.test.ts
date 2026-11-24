import { toStaticManifest } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { checkManifest } from "../src/app-host/contract.js";
import lamps from "./fixtures/apps/lamps/index.js";

describe("a driver's problem declarations at installation", () => {
  it("accepts the problems and repair hook in a generated manifest", () => {
    const manifest = toStaticManifest(lamps);
    expect(checkManifest(manifest)).toBe(manifest);
  });

  it.each([
    { hooks: ["command", "repair"], problems: { broken: { words: "Broken" } } },
    {
      hooks: ["command", "repair"],
      problems: { broken: { words: "Broken", repair: { asks: ["missing"] } } },
    },
    {
      hooks: ["command"],
      problems: { broken: { words: "Broken", repair: { asks: [] } } },
    },
    { hooks: ["command"], problems: { broken: { words: 123 } } },
  ])("rejects inconsistent declarations read from a package (%j)", (driver) => {
    const manifest = toStaticManifest(lamps);
    manifest.driver = driver as never;
    expect(() => checkManifest(manifest)).toThrow();
  });
});

describe("an app's ports at installation", () => {
  it("accepts more than 16 single-port declarations from an earlier protocol", () => {
    const manifest = toStaticManifest(lamps);
    manifest.protocol = 17;
    const permission = (id: string) => ({
      id,
      reason: "For the test.",
      needed: false,
      asked: null,
      startsOn: false,
    });
    manifest.permissions = [
      ...manifest.permissions,
      permission("discover:mdns:_example._tcp"),
      ...Array.from({ length: 17 }, (_, index) =>
        permission(`lan:tcp:${7000 + index}`),
      ),
    ];
    expect(checkManifest(manifest)).toBe(manifest);
  });

  it.each([
    ["a malformed one", ["lan:tcp:any"], "must name a TCP port"],
    ["a range outside the session ports", ["lan:tcp:1-65535"], "must name"],
    [
      "two that share ports",
      ["lan:tcp:50000", "lan:tcp:49152-65535"],
      "share ports",
    ],
    [
      "more than 16",
      Array.from({ length: 17 }, (_, index) => `lan:tcp:${7000 + index}`),
      "at most 16",
    ],
  ])("refuses %s read from a package", (_, ports, refusal) => {
    const manifest = toStaticManifest(lamps);
    manifest.permissions = [
      ...manifest.permissions,
      { id: "discover:mdns:_example._tcp", reason: "For the test." },
      ...ports.map((id) => ({ id, reason: "For the test." })),
    ] as typeof manifest.permissions;
    expect(() => checkManifest(manifest)).toThrow(refusal);
  });
});
