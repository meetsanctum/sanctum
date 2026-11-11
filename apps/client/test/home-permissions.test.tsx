// @vitest-environment jsdom
import type { AppInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { Home } from "../src/Home";
import type { StoredHost } from "../src/shell";

// An app's permission switched on its settings page (app-settings.tsx): the
// shell takes the core's answer at once for everything that shows the app,
// and an older read of the apps that finishes after it can't undo it.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
  currentCredential: () => null,
}));
vi.mock("../src/auth/session", () => ({
  followHost: (host: StoredHost, found: (url: string) => void) => {
    found(host.url);
    return () => {};
  },
}));
vi.mock("../src/live", () => ({
  connectLive: () => ({ stop() {}, retryNow() {} }),
}));
vi.mock("../src/core-status", () => ({
  startCoreStatusPolling: () => ({ stop() {}, checkNow() {} }),
}));

const app: AppInfo = {
  id: "test.app",
  name: "Test app",
  version: "0.1.0",
  icon: null,
  pages: [],
  permissions: ["places.read"],
  requests: [
    {
      id: "places.read",
      reason: "To list rooms.",
      needed: false,
      asked: null,
      startsOn: false,
    },
  ],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};
const host: StoredHost = {
  hostId: "host",
  homeId: "home",
  name: "Home",
  url: "http://localhost:4100",
  clientId: "client",
  token: "test-token",
  kind: "shared",
  pin: null,
};
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/apps") return [app];
    if (path === "/api/auth/me")
      return { client: { kind: "shared" }, person: null };
    if (path === "/api/dashboards")
      return [
        {
          id: "home",
          name: "Home",
          kind: "home",
          background: "mocha",
          devices: [],
        },
      ];
    if (path === "/api/devices") return [];
    if (path === "/api/places")
      return {
        home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
        rooms: [],
        zones: [],
        floors: [],
      };
    if (path === "/api/apps/test.app/permissions/update")
      return { ...app, permissions: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <Home
        host={host}
        onHostMoved={() => {}}
        onSignedOut={() => {}}
        onCertificateChanged={() => {}}
      />,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps a confirmed permission change when an older app refresh finishes", async () => {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('aside [aria-label="Apps"]')!
      .click(),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("main li button")]
      .find((button) => button.textContent === "Settings")!
      .click(),
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("main li button")]
      .find((button) => button.textContent?.startsWith("Test app"))!
      .click(),
  );
  const toggle = () =>
    container.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="See your rooms"]',
    )!;
  expect(toggle().getAttribute("aria-checked")).toBe("true");

  let finish!: (apps: AppInfo[]) => void;
  const stale = new Promise<AppInfo[]>((resolve) => {
    finish = resolve;
  });
  const request = vi.mocked(coreJson).getMockImplementation()!;
  vi.mocked(coreJson).mockImplementation((path, init) =>
    path === "/api/apps" ? stale : request(path, init),
  );
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await act(async () => toggle().click());
  expect(toggle().getAttribute("aria-checked")).toBe("false");

  await act(async () => finish([app]));
  expect(toggle().getAttribute("aria-checked")).toBe("false");
});
