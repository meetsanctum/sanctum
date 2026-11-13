import type { AppInfo, DashboardInfo } from "@meetsanctum/app-sdk";

import type { StoredHost } from "../src/shell";

export const moods: AppInfo = {
  id: "sanctum.moods",
  name: "Moods",
  version: "0.1.0",
  icon: { glyph: "sparkles", color: "ember" },
  pages: ["room", "category"],
  permissions: ["places.read", "devices.control:light"],
  requests: [],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};
export const weather: AppInfo = {
  id: "sanctum.weather",
  name: "Weather",
  version: "0.2.0",
  icon: { glyph: "cloud-sun", color: "sky" },
  pages: ["main"],
  permissions: ["places.location"],
  requests: [],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};
// An app whose own page opens its preferences.
export const naturalLight: AppInfo = {
  id: "sanctum.natural-light",
  name: "Natural light",
  version: "0.1.0",
  icon: { glyph: "sun", color: "sun" },
  pages: ["main"],
  permissions: ["places.location", "devices.control:light"],
  requests: [],
  state: "running",
  settings: {
    type: "object",
    properties: {
      shape: {
        type: "string",
        title: "Curve",
        enum: ["balanced", "early_riser"],
        options: { balanced: "Balanced", early_riser: "Early riser" },
        default: "balanced",
      },
    },
  },
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};
export const host: StoredHost = {
  hostId: "host",
  homeId: "home",
  name: "Home",
  url: "http://localhost:4100",
  clientId: "client",
  token: "test-token",
  kind: "personal",
  pin: null,
};

export const homeDashboard: DashboardInfo = {
  id: "d-home",
  name: "Home",
  background: "mocha",
  kind: "home",
  devices: [],
};
export const night: DashboardInfo = {
  id: "d-night",
  name: "Night",
  background: "mocha",
  kind: "custom",
};
