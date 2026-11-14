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
