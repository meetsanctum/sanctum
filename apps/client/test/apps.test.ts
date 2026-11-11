import type { AppInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed, type CoreBridge } from "@meetsanctum/ui-sdk";
import { describe, expect, it, vi } from "vitest";

import { hostedApps, opens, pageOf } from "../src/apps";

// The apps the shell hosts: those the core lists as installed whose UI it
// bundles, each with a client limited to what the core says it holds.

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
  it("are the installed apps the shell has a UI for", () => {
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

  it("opens only pages that are both installed and bundled", () => {
    const [moods] = hostedApps(
      [app("sanctum.moods", "Moods", ["room", "missing", "constructor"])],
      bridge(),
    );
    expect(pageOf(moods, "room")).toBe(moods!.ui.pages.room);
    expect(pageOf(moods, "category")).toBeUndefined();
    expect(pageOf(moods, "main")).toBeUndefined();
    expect(pageOf(moods, "missing")).toBeUndefined();
    expect(pageOf(moods, "constructor")).toBeUndefined();
    expect(pageOf(undefined, "main")).toBeUndefined();
  });
});
