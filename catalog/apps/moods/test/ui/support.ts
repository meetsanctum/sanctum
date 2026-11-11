import type { AppInfo } from "@meetsanctum/app-sdk";
import type { LiveListener } from "@meetsanctum/ui-sdk";
import { vi } from "vitest";

// A client for Moods' UI that answers what each test gives it.
export function fakeClient() {
  const app: AppInfo = {
    id: "sanctum.moods",
    name: "Moods",
    version: "0.3.0",
    icon: { glyph: "sparkles", color: "ember" },
    pages: ["main", "room", "mood"],
    permissions: [
      "places.read",
      "devices.control:light",
      "devices.read:button",
      "devices.read:occupancy",
      "devices.read:sensor",
      "workflows.manage",
    ],
    requests: [],
    state: "running",
    settings: null,
    provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
  };
  return {
    app,
    call: vi.fn(),
    places: vi.fn(),
    devices: vi.fn(),
    command: vi.fn(),
    entities: vi.fn(async () => []),
    settings: vi.fn(async () => ({})),
    capturePresses: vi.fn(),
    ask: vi.fn(async () => true),
    subscribe: vi.fn((_listener: LiveListener) => () => {}),
  };
}
