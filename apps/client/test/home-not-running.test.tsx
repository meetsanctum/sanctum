// @vitest-environment jsdom
import type { AppInfo, EntityInfo, LiveMessage } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { Home } from "../src/Home";
import type { LiveState } from "../src/live";
import type { StoredHost } from "../src/shell";
import { light } from "./settings-devices-fixtures";

// An app that isn't running, said everywhere it shows: its page under the
// shell's notice, dimmed and inert, its tiles and card on Home dimmed with
// why, and Home's Attention tile and Settings' Needs attention leading to the
// fix.

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
// What the core pushes over the live socket.
const socket = vi.hoisted(() => ({
  push: (_message: LiveMessage) => {},
  setState: (_state: LiveState) => {},
}));
vi.mock("../src/live", () => ({
  connectLive: (
    onState: (state: LiveState) => void,
    onMessage: (message: LiveMessage) => void,
  ) => {
    socket.push = onMessage;
    socket.setState = onState;
    return { stop() {}, retryNow() {} };
  },
}));
vi.mock("../src/core-status", () => ({
  startCoreStatusPolling: () => ({ stop() {}, checkNow() {} }),
}));

const moods: AppInfo = {
  id: "sanctum.moods",
  name: "Moods",
  version: "0.8.0",
  icon: { glyph: "sparkles", color: "ember" },
  pages: ["room"],
  permissions: ["places.read"],
  requests: [
    {
      id: "places.read",
      reason: "To keep moods.",
      needed: true,
      asked: null,
      startsOn: false,
    },
    {
      id: "devices.control:light",
      reason: "To set your lights when a mood runs.",
      needed: true,
      asked: null,
      startsOn: false,
    },
  ],
  state: "paused",
  settings: null,
  provides: {
    entities: [],
    widgets: [],
    roomSections: [
      {
        id: "moods.room",
        title: "Moods",
        entityType: "moods.mood",
        kind: "tiles",
        order: 200,
        press: { action: "moods.runMood" },
        open: { page: "room", label: "Edit" },
        whenEmpty: { roomHas: "light" },
      },
    ],
    devicePages: [],
  },
};
const weather: AppInfo = {
  id: "sanctum.weather",
  name: "Weather",
  version: "0.3.0",
  icon: { glyph: "cloud-sun", color: "sky" },
  pages: ["main"],
  permissions: ["places.location"],
  requests: [
    {
      id: "places.location",
      reason: "For the forecast.",
      needed: true,
      asked: null,
      startsOn: false,
    },
  ],
  state: "running",
  settings: null,
  provides: {
    entities: [],
    widgets: [
      { id: "weather.card", title: "Weather", size: { columns: 4, rows: 4 } },
    ],
    roomSections: [],
    devicePages: [],
  },
};
const aurora: EntityInfo = {
  app: "sanctum.moods",
  key: "aurora",
  type: "moods.mood",
  name: "Aurora",
  state: {
    placeId: "kitchen",
    name: "Aurora",
    icon: "sparkles",
    order: 0,
    active: true,
    input: { id: "aurora" },
  },
  updatedAt: "2026-11-03T09:00:00.000Z",
};
const card: EntityInfo = {
  app: "sanctum.weather",
  key: "home",
  type: "weather.card",
  name: "Weather",
  state: {
    blocks: [
      { kind: "headline", icon: "cloud-sun", value: { temperature: 7 } },
      { kind: "action", label: "Open Weather", page: "main" },
    ],
  },
  updatedAt: "2026-11-03T09:00:00.000Z",
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
let installed: AppInfo[];

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

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  installed = [moods, weather];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path.startsWith("/api/entities?")) {
      const query = new URLSearchParams(path.slice(path.indexOf("?")));
      return [aurora, card].filter(
        (entity) =>
          entity.app === query.get("app") &&
          (!query.has("type") || entity.type === query.get("type")),
      );
    }
    switch (path) {
      case "/api/auth/me":
        return { client: { kind: "shared" }, person: null };
      case "/api/apps":
        return installed;
      case "/api/dashboards":
        return [
          {
            id: "home",
            name: "Home",
            background: "mocha",
            kind: "home",
            devices: [],
          },
        ];
      case "/api/devices":
        // In a room, so only the apps need attention.
        return [{ ...light("lamp", "Lamp"), roomId: "kitchen" }];
      case "/api/places":
        return {
          home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
          rooms: [{ id: "kitchen", name: "Kitchen", floorId: null }],
          zones: [],
          floors: [],
        };
      default:
        // Weather's page and the settings page read what they show; none
        // of it matters here.
        if (path.startsWith("/api/apps/")) return null;
        throw new Error(`Unexpected request: ${path}`);
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const press = async (button: HTMLElement) => {
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
};
const buttonCalled = (name: string, root: ParentNode = container) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) =>
      button.textContent === name || button.getAttribute("aria-label") === name,
  );
const pageTitle = () => container.querySelector(".top-bar h1")?.textContent;

async function openWeather() {
  await press(buttonCalled("Apps")!);
  await press(buttonCalled("Weather", container.querySelector("main")!)!);
  expect(pageTitle()).toBe("Weather");
}

it("dims a paused app's tiles on Home, saying Paused, and nothing presses them", async () => {
  const tile = buttonCalled("AuroraPaused")!;
  expect(tile.disabled).toBe(true);
  // It keeps its last state.
  expect(tile.getAttribute("aria-pressed")).toBe("true");
  await press(tile);
  expect(
    vi
      .mocked(coreJson)
      .mock.calls.some(([path]) => path.includes("moods.runMood")),
  ).toBe(false);
});

it("says beside a stopped app's card that it isn't running, and nothing on it presses", async () => {
  installed = [moods, { ...weather, state: "stopped" }];
  await act(async () => window.dispatchEvent(new Event("focus")));
  const article = container.querySelector<HTMLElement>(
    "main article[aria-labelledby]",
  )!;
  expect(article.querySelector("h2")?.textContent).toBe("Weather, Not running");
  expect(article.querySelector("[inert]")?.textContent).toContain(
    "Open Weather",
  );
});

it("puts the shell's notice above a paused app's page, which is dimmed and inert, and opens its settings", async () => {
  installed = [moods, { ...weather, permissions: [], state: "paused" }];
  await act(async () => window.dispatchEvent(new Event("focus")));
  await openWeather();

  const notice = container.querySelector('main [role="status"]')!;
  expect(notice.textContent).toBe(
    "Weather is pausedIt needs “Know where your home is” to work. Turn it back on in its settings to start it again.Open settings",
  );
  expect(notice.nextElementSibling?.hasAttribute("inert")).toBe(true);
  expect(notice.nextElementSibling?.className).toContain("opacity-50");
  // The gear stays, as the page's way out does.
  expect(buttonCalled("Weather settings")).toBeDefined();

  await press(buttonCalled("Open settings", notice)!);
  expect(pageTitle()).toBe("Weather settings");
});

it("follows an app paused on another device at once, with no refresh", async () => {
  await openWeather();
  const main = () => container.querySelector("main")!;
  expect(main().textContent).not.toContain("Weather is paused");

  await act(async () =>
    socket.push({
      type: "app",
      app: { ...weather, permissions: [], state: "paused" },
    }),
  );
  expect(main().textContent).toContain("Weather is paused");
  expect(main().querySelector("[inert]")).not.toBeNull();
});

it("keeps the initial app list when a live grant change arrives during its read", async () => {
  await act(async () => root.unmount());
  const original = vi.mocked(coreJson).getMockImplementation()!;
  let finish!: (apps: AppInfo[]) => void;
  const pending = new Promise<AppInfo[]>((resolve) => {
    finish = resolve;
  });
  vi.mocked(coreJson).mockImplementation((path, init) =>
    path === "/api/apps" ? pending : original(path, init),
  );
  root = createRoot(container);
  await render();
  await act(async () => {
    socket.push({
      type: "app",
      app: { ...weather, permissions: [], state: "paused" },
    });
    finish(installed);
  });

  expect(buttonCalled("AuroraPaused")).toBeDefined();
  await openWeather();
  expect(container.querySelector("main")!.textContent).toContain(
    "Weather is paused",
  );
});

it("reads grants missed while the live connection was away as soon as it returns", async () => {
  await openWeather();
  await act(async () => socket.setState("offline"));
  installed = [moods, { ...weather, permissions: [], state: "paused" }];
  await act(async () => socket.setState("live"));

  expect(container.querySelector("main")!.textContent).toContain(
    "Weather is paused",
  );
});

it("sends a stopped app's page to Status, where Restart is", async () => {
  installed = [moods, { ...weather, state: "stopped" }];
  await act(async () => window.dispatchEvent(new Event("focus")));
  await openWeather();

  const notice = container.querySelector('main [role="status"]')!;
  expect(notice.textContent).toContain("Weather isn't running");
  expect(buttonCalled("Open settings", notice)).toBeUndefined();
  await press(buttonCalled("Open Status", notice)!);
  expect(pageTitle()).toBe("Status");
});

it("counts a paused app on Home's Attention tile, which leads to its row in Needs attention", async () => {
  const tile = container.querySelector<HTMLButtonElement>(
    '[aria-label="Home status"] button[aria-label="Moods is paused"]',
  )!;
  expect(tile.textContent).toBe("MoodsPaused");
  // Not a problem: someone switched off what it needs.
  expect(tile.querySelector("svg")?.getAttribute("style")).toContain(
    "--graphite-text",
  );

  await press(tile);
  const section = container.querySelector(
    'section[aria-labelledby="settings-attention"]',
  )!;
  expect(section.querySelector("h2")?.nextElementSibling?.textContent).toBe(
    "Moods",
  );
  expect(section.querySelector("li")?.textContent).toBe(
    "MoodsPaused: it needs “Control your lights”Open settings",
  );
  await press(buttonCalled("Open Moods settings", section)!);
  expect(pageTitle()).toBe("Moods settings");
});
