import type {
  AppInfo,
  DashboardInfo,
  EntityInfo,
  LiveMessage,
  Places,
} from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import type { CoreStatus } from "../src/core-status";
import { Home } from "../src/Home";
import type { LiveState } from "../src/live";
import type { StoredHost } from "../src/shell";
import { homeDashboard, host, moods } from "./home-shell-fixtures";

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
const coreStatus = vi.hoisted(() => ({
  publish: (_status: CoreStatus) => {},
}));
vi.mock("../src/core-status", () => ({
  startCoreStatusPolling: (onStatus: (status: CoreStatus) => void) => {
    coreStatus.publish = onStatus;
    onStatus({ state: "online", version: "dev" });
    return { stop() {}, checkNow() {} };
  },
}));
// What the core pushes over the live socket.
const socket = vi.hoisted(() => ({
  push: (_message: LiveMessage) => {},
  state: (_state: LiveState) => {},
}));
vi.mock("../src/live", () => ({
  connectLive: (
    onState: (state: LiveState) => void,
    onMessage: (message: LiveMessage) => void,
  ) => {
    socket.push = onMessage;
    socket.state = onState;
    return { stop() {}, retryNow() {} };
  },
}));

export function publishCoreStatus(status: CoreStatus) {
  coreStatus.publish(status);
}

export function pushLive(message: LiveMessage) {
  socket.push(message);
}

export function pushLiveState(state: LiveState) {
  socket.state(state);
}

export const mockCoreJson = vi.mocked(coreJson);

let root: Root;
export let container: HTMLDivElement;

const kitchen = { id: "kitchen", name: "Kitchen", floorId: null };

export const homeData = {
  rooms: [kitchen] as { id: string; name: string; floorId: string | null }[],
  installed: [] as AppInfo[],
  dashboards: [] as DashboardInfo[],
  entities: [] as EntityInfo[],
  devices: [] as unknown[],
  pins: [] as string[],
};

export function placesSnapshot(): Places {
  return {
    home: {
      name: "Our home",
      timeZone: "UTC",
      temperatureUnit: "celsius",
    },
    rooms: homeData.rooms,
    floors: [],
    zones: [],
  };
}

function renderHome() {
  root.render(
    <Home
      host={host}
      onHostMoved={() => {}}
      onSignedOut={() => {}}
      onCertificateChanged={() => {}}
    />,
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  homeData.installed = [moods];
  homeData.dashboards = [homeDashboard];
  homeData.entities = [];
  homeData.devices = [];
  homeData.rooms = [kitchen];
  homeData.pins = [];
  mockCoreJson.mockReset();
  mockCoreJson.mockImplementation(async (path, init) => {
    if (path.startsWith("/api/entities?")) {
      const query = new URLSearchParams(path.slice(path.indexOf("?")));
      return homeData.entities.filter(
        (entity) =>
          entity.app === query.get("app") && entity.type === query.get("type"),
      );
    }
    switch (path) {
      case "/api/auth/me":
        return { client: { kind: "shared" }, person: null };
      case "/api/apps":
        return homeData.installed;
      case "/api/dashboards":
        return homeData.dashboards;
      case "/api/dashboards/update": {
        const { id, name } = init!.json as { id: string; name: string };
        homeData.dashboards = homeData.dashboards.map((dashboard) =>
          dashboard.id === id ? { ...dashboard, name } : dashboard,
        );
        return homeData.dashboards.find((dashboard) => dashboard.id === id);
      }
      case "/api/pins":
        return homeData.pins;
      case "/api/pins/update":
        homeData.pins = (init!.json as { apps: string[] }).apps;
        return homeData.pins;
      case "/api/devices":
        return homeData.devices;
      case "/api/entities":
        return [];
      case "/api/apps/sanctum.natural-light/settings":
        return { shape: "balanced" };
      case "/api/apps/sanctum.natural-light/actions/naturalLight.preview":
        return null;
      case "/api/places":
        return placesSnapshot();
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => renderHome());
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

export async function refresh() {
  await act(async () => window.dispatchEvent(new Event("focus")));
}

export async function remountHome() {
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => renderHome());
}
