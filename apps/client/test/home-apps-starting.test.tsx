// @vitest-environment jsdom
import type { LiveMessage } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import { Home } from "../src/Home";
import type { LiveState } from "../src/live";
import type { StoredHost } from "../src/shell";
import { homeDashboard, host, moods, weather } from "./home-shell-fixtures";

// A core that can't say which apps the home has, as while it installs them
// after an update: the shell keeps the apps it has, asks again soon, and one
// opened meanwhile says its apps are still starting.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
  currentCredential: () => null,
}));
vi.mock("../src/auth/session", () => ({
  followHost: (stored: StoredHost, found: (url: string) => void) => {
    found(stored.url);
    return () => {};
  },
}));
const socket = vi.hoisted(() => ({
  setState: (_state: LiveState) => {},
}));
vi.mock("../src/live", () => ({
  connectLive: (
    onState: (state: LiveState) => void,
    _onMessage: (message: LiveMessage) => void,
  ) => {
    socket.setState = onState;
    return { stop() {}, retryNow() {} };
  },
}));
vi.mock("../src/core-status", () => ({
  startCoreStatusPolling: () => ({ stop() {}, checkNow() {} }),
}));

let root: Root;
let container: HTMLDivElement;
// Whether the core has installed its apps.
let hasInstalled: boolean;

async function render() {
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
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  hasInstalled = true;
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    switch (path) {
      case "/api/auth/me":
        return { client: { kind: "shared" }, person: null };
      case "/api/apps":
        if (!hasInstalled) throw new CoreError(503, "unavailable");
        return [moods, weather];
      case "/api/dashboards":
        return [homeDashboard];
      case "/api/devices":
        return [];
      case "/api/places":
        return {
          home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
          rooms: [],
          zones: [],
          floors: [],
        };
      case "/api/places/home":
        return { coordinates: null };
      default:
        return null;
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const later = (ms: number) =>
  act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const buttonCalled = (name: string, within: ParentNode = container) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) =>
      button.textContent === name || button.getAttribute("aria-label") === name,
  );
const page = () => container.querySelector("main")!;
async function openApps() {
  await act(async () => buttonCalled("Apps")!.click());
  await later(10);
}
const reads = () =>
  vi.mocked(coreJson).mock.calls.filter(([path]) => path === "/api/apps")
    .length;

it("says its apps are still starting when it opens before the core has installed them, and lists them once it has", async () => {
  hasInstalled = false;
  await render();
  await openApps();
  expect(buttonCalled("Settings", page())).toBeTruthy();
  expect(buttonCalled("Automations", page())).toBeTruthy();
  expect(buttonCalled("Weather", page())).toBeUndefined();
  expect(page().querySelector("[role=status]")?.textContent).toBe(
    "Your apps are still starting. They'll show here in a moment.",
  );

  // It asks again by itself, and goes on asking while the core can't say.
  const before = reads();
  await later(2_000);
  expect(reads()).toBe(before + 1);
  expect(buttonCalled("Weather", page())).toBeUndefined();

  hasInstalled = true;
  await later(2_000);
  expect(buttonCalled("Weather", page())).toBeTruthy();
  expect(page().querySelector("[role=status]")).toBeNull();
  // And no more once it has them.
  const settled = reads();
  await later(10_000);
  expect(reads()).toBe(settled);
});

it("keeps the apps it has while the core can't say, without a word", async () => {
  await render();
  await openApps();
  expect(buttonCalled("Weather", page())).toBeTruthy();

  // The core comes back from an update, its apps not installed yet.
  hasInstalled = false;
  await act(async () => socket.setState("live"));
  await later(2_000);
  expect(buttonCalled("Weather", page())).toBeTruthy();
  expect(page().querySelector("[role=status]")).toBeNull();

  hasInstalled = true;
  await later(2_000);
  expect(buttonCalled("Weather", page())).toBeTruthy();
});
