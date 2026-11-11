// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { Home } from "../src/Home";
import * as shell from "../src/shell";
import type { StoredHost } from "../src/shell";
import { lamp, places } from "./device-detail-fixtures";

// A device's detail through the real Home: as it covers the window, the
// macOS traffic lights hide (src/overlay.tsx, src/sidebar-state.ts).

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
const setControls = vi.fn(async (_visible: boolean, _by?: number) => {});
let root: Root;
let container: HTMLDivElement;

const dialog = () => container.querySelector('[role="dialog"]');
const press = (label: string) =>
  act(async () => {
    [...container.querySelectorAll("button")]
      .find(
        (each) =>
          each.getAttribute("aria-label") === label ||
          each.textContent === label,
      )!
      .click();
  });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  setControls.mockClear();
  vi.spyOn(shell, "getShell").mockReturnValue({
    ...shell.getShell(),
    window: {
      setControls,
      setSidebar: async () => {},
      onToggleSidebar: () => () => {},
    },
  });
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/apps") return [];
    if (path === "/api/auth/me")
      return { client: { kind: "shared" }, person: null };
    if (path === "/api/dashboards")
      return [
        {
          id: "home",
          name: "Home",
          kind: "home",
          background: "mocha",
          devices: [lamp.id],
        },
      ];
    if (path === "/api/devices") return [lamp];
    if (path === "/api/places") return places;
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
  vi.restoreAllMocks();
});

it("hides the traffic lights while a device's detail covers the window", async () => {
  expect(setControls).toHaveBeenLastCalledWith(true, 0);
  setControls.mockClear();

  await press("Lamp, 40%");
  expect(dialog()).not.toBeNull();
  // Where the frame's backing looks for it (src/shell-frame.css).
  expect(dialog()!.parentElement!.className).toBe("home-screen");
  expect(setControls.mock.calls).toEqual([[false, 0]]);

  await press("Done");
  expect(dialog()).toBeNull();
  expect(setControls.mock.calls).toEqual([
    [false, 0],
    [true, 0],
  ]);
});
