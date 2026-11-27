// @vitest-environment jsdom
import type {
  AppInfo,
  AvailableApp,
  HardwareOffer,
  LiveMessage,
} from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import type { CoreStatus } from "../src/core-status";
import * as dashboard from "../src/home-dashboard";
import { Home } from "../src/Home";
import type { LiveState } from "../src/live";
import * as shell from "../src/shell";
import type { StoredHost } from "../src/shell";
import { lamp, places } from "./device-detail-fixtures";
import { motionCapability } from "./device-tiles-fixtures";
import { moods } from "./home-shell-fixtures";
import { contactSensor } from "./place-pages-fixtures";

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
const socket = vi.hoisted(() => ({ push: (_message: LiveMessage) => {} }));
vi.mock("../src/live", () => ({
  connectLive: (
    _onState: (state: LiveState) => void,
    onMessage: (message: LiveMessage) => void,
  ) => {
    socket.push = onMessage;
    return { stop() {}, retryNow() {} };
  },
}));
const status = vi.hoisted(() => ({ publish: (_status: CoreStatus) => {} }));
vi.mock("../src/core-status", () => ({
  startCoreStatusPolling: (onStatus: (status: CoreStatus) => void) => {
    status.publish = onStatus;
    return { stop() {}, checkNow() {} };
  },
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
const door = contactSensor("door", "Hallway door", "office", false);
const devices = [
  lamp,
  { ...door, capabilities: [...door.capabilities, motionCapability(false)] },
];
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

// Settings and Automations load when first opened (Home.tsx): loaded here
// first, they open as quickly as the tests look for them.
beforeAll(() =>
  Promise.all([import("../src/settings"), import("../src/automations/page")]),
);

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
  vi.spyOn(dashboard, "HomeRooms");
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
    if (path === "/api/devices") return devices;
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

it("hides the traffic lights while detail covers the window without redrawing Home", async () => {
  expect(setControls).toHaveBeenLastCalledWith(true, 0);
  setControls.mockClear();
  const dashboardRenders = vi.mocked(dashboard.HomeRooms).mock.calls.length;
  expect(dashboardRenders).toBeGreaterThan(0);

  await press("Lamp, 40%");
  expect(dialog()).not.toBeNull();
  // Where the frame's backing looks for it (src/shell-frame.css).
  expect(dialog()!.parentElement!.className).toBe("home-screen");
  expect(setControls.mock.calls).toEqual([[false, 0]]);
  expect(dashboard.HomeRooms).toHaveBeenCalledTimes(dashboardRenders);

  await press("Done");
  expect(dialog()).toBeNull();
  expect(setControls.mock.calls).toEqual([
    [false, 0],
    [true, 0],
  ]);
  expect(dashboard.HomeRooms).toHaveBeenCalledTimes(dashboardRenders);
});

it("opens a room's contact tile on the device's first page", async () => {
  await press("Office");
  await press("Hallway door, Closed");

  const selected = dialog()?.querySelector(
    '[role="tab"][aria-selected="true"]',
  );
  expect(selected?.getAttribute("aria-label")).toBe("Motion");
});

it("opens the room's shared light controls from its Lights tile", async () => {
  await press("Office");
  await press("Lights in Office, 40%");

  expect(dialog()?.querySelector("h2")?.textContent).toBe("Lights");
  expect(dialog()?.textContent).toContain("Office · 40%");
  expect(
    dialog()?.querySelector('[role="tab"][aria-label="Brightness"]'),
  ).not.toBeNull();
});

it("updates the name in an open device detail", async () => {
  await press("Lamp, 40%");
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Lamp");

  await act(async () =>
    socket.push({
      type: "device",
      id: lamp.id,
      device: { ...lamp, name: "Office Lamp" },
    }),
  );

  expect(dialog()?.querySelector("h2")?.textContent).toBe("Office Lamp");
});

it("opens the app after adding it from a hardware offer, as Apps does", async () => {
  const added: AppInfo = { ...moods, id: "sanctum.example", name: "Example" };
  const available: AvailableApp = {
    id: added.id,
    name: added.name,
    version: added.version,
    icon: added.icon,
    summary: null,
    requests: [],
    memory: 128,
    data: 256,
    adds: { devices: true },
    shortfalls: [],
  };
  const offer: HardwareOffer = {
    id: "offer-1",
    app: available.id,
    sticks: [{ path: "/dev/serial/by-id/zigbee-stick", label: "Zigbee stick" }],
  };
  const read = vi.mocked(coreJson).getMockImplementation()!;
  vi.mocked(coreJson).mockImplementation(async (path, init) => {
    if (path === "/api/hardware/offer") return { offer };
    if (path === "/api/apps/available") return [available];
    if (path === "/api/apps/add") return added;
    return read(path, init);
  });
  await act(async () => status.publish({ state: "online", version: "dev" }));

  const sheet = document.querySelector('[role="dialog"]');
  expect(sheet?.textContent).toContain("A Zigbee stick was plugged in");
  const add = [...sheet!.querySelectorAll("button")].find(
    (button) => button.textContent === "Add",
  );
  await act(async () => add!.click());

  expect(container.querySelector("main h1")?.textContent).toBe("Example");
  expect(container.querySelector("main")?.textContent).toContain(
    `Version ${added.version}`,
  );
});
