import type { AppInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed, type CoreBridge } from "@meetsanctum/ui-sdk";
import { describe, expect, it, vi } from "vitest";

import { hasPage, hostedApps, opens } from "../src/apps";

// The apps the shell hosts: every one the core lists as installed, each with
// a client limited to what the core says it holds, and the pages it lists.

const app = (id: string, name: string, pages: string[] = []): AppInfo => ({
  id,
  name,
  version: "0.1.0",
  icon: pages.length ? { glyph: "sparkles", color: "ember" } : null,
  pages,
  permissions: ["places.read", "devices.control:light"],
  requests: [],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
});

const bridge = (): CoreBridge => ({
  json: vi.fn() as CoreBridge["json"],
  live: createLiveFeed(),
  ask: vi.fn(),
});

describe("hosted apps", () => {
  it("are the installed apps, in the core's order, whatever their pages", () => {
    const hosted = hostedApps(
      [
        app("sanctum.zigbee", "Zigbee", ["main"]),
        app("sanctum.moods", "Moods", ["room", "category"]),
        app("sanctum.example", "Example", ["main"]),
      ],
      bridge(),
    );
    expect(hosted.map((each) => each.info.id)).toEqual([
      "sanctum.zigbee",
      "sanctum.moods",
      "sanctum.example",
    ]);
  });

  it("run with the permissions the core lists", () => {
    const [moods] = hostedApps(
      [app("sanctum.moods", "Moods", ["main"])],
      bridge(),
    );
    expect(moods!.client.app.permissions).toEqual([
      "places.read",
      "devices.control:light",
    ]);
  });

  it("open from the overview at a main page the core lists, as Moods and Zigbee", () => {
    const [moods, zigbee] = hostedApps(
      [
        app("sanctum.moods", "Moods", ["main", "room", "category"]),
        app("sanctum.zigbee", "Zigbee", ["main"]),
      ],
      bridge(),
    );
    expect(opens(moods!)).toBe(true);
    expect(opens(zigbee!)).toBe(true);
    const [older] = hostedApps(
      [app("sanctum.moods", "Moods", ["room", "category"])],
      bridge(),
    );
    expect(opens(older!)).toBe(false);
  });

  it("open only the pages the core lists", () => {
    const [moods] = hostedApps(
      [app("sanctum.moods", "Moods", ["room", "constructor"])],
      bridge(),
    );
    expect(hasPage(moods, "room")).toBe(true);
    expect(hasPage(moods, "constructor")).toBe(true);
    expect(hasPage(moods, "main")).toBe(false);
    expect(hasPage(moods, "toString")).toBe(false);
    expect(hasPage(undefined, "main")).toBe(false);
  });
});
