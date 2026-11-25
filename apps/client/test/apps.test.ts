import type { AppInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed, type CoreBridge } from "@meetsanctum/ui-sdk";
import { describe, expect, it, vi } from "vitest";

import { hasDefaultPage, hasPage, hostedApps, showsPage } from "../src/apps";

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

  it("show their own main page where the core lists one, else the shell's default", () => {
    const [moods, zigbee] = hostedApps(
      [
        app("sanctum.moods", "Moods", ["main", "room", "category"]),
        app("sanctum.zigbee", "Zigbee", ["main"]),
      ],
      bridge(),
    );
    expect(hasDefaultPage(moods)).toBe(false);
    expect(hasDefaultPage(zigbee)).toBe(false);
    const [older, driver] = hostedApps(
      [
        app("sanctum.moods", "Moods", ["room", "category"]),
        app("sanctum.example", "Example"),
      ],
      bridge(),
    );
    expect(hasDefaultPage(older)).toBe(true);
    expect(hasDefaultPage(driver)).toBe(true);
    expect(showsPage(driver, "main")).toBe(true);
    // Only the main page has a default; another page it lacks isn't shown.
    expect(showsPage(driver, "room")).toBe(false);
    expect(hasDefaultPage(undefined)).toBe(false);
    expect(showsPage(undefined, "main")).toBe(false);
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
