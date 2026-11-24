// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";

// Load the harness first so the screen uses its data fixtures.
import {
  container,
  homeData,
  mockCoreJson,
  placesSnapshot,
  pushLive,
  refresh,
  remountHome,
} from "./home-shell-harness";
import * as appsPage from "../src/apps-page";
import { useArtwork } from "../src/artwork";
import * as deviceDetail from "../src/device-detail";
import * as placePages from "../src/place-pages";
import * as shellFrame from "../src/shell-frame";
import * as topBar from "../src/top-bar";
import { homeDashboard } from "./home-shell-fixtures";
import { finishFade, withFade } from "./overlay-fade";
import { mediaPlayer } from "./place-pages-fixtures";
import { light } from "./settings-devices-fixtures";

vi.mock(import("../src/device-detail"), async (original) => {
  const actual = await original();
  return { ...actual, DeviceDetail: vi.fn(actual.DeviceDetail) };
});
vi.mock(import("../src/apps-page"), async (original) => {
  const actual = await original();
  return { ...actual, AppsPage: vi.fn(actual.AppsPage) };
});
vi.mock("../src/artwork", () => ({ useArtwork: vi.fn(() => null) }));
vi.mock(import("../src/place-pages"), async (original) => {
  const actual = await original();
  return { ...actual, SidebarPlaces: vi.fn(actual.SidebarPlaces) };
});
vi.mock(import("../src/shell-frame"), async (original) => {
  const actual = await original();
  return { ...actual, ShellFrame: vi.fn(actual.ShellFrame) };
});
vi.mock(import("../src/top-bar"), async (original) => {
  const actual = await original();
  return { ...actual, TopBar: vi.fn(actual.TopBar) };
});

afterEach(() => vi.restoreAllMocks());

const dialog = () => container.ownerDocument.querySelector('[role="dialog"]');

function withDeviceDetailFade() {
  withFade();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
}

function pressDone(opened: Element) {
  return act(async () =>
    [...opened.querySelectorAll("button")]
      .find((button) => button.textContent === "Done")!
      .click(),
  );
}

it("draws a device's change without redrawing the frame or top bar", async () => {
  homeData.rooms = [{ id: "kitchen", name: "Kitchen", floorId: null }];
  const lamp = light("lamp", "Lamp", { roomId: "kitchen" });
  homeData.devices = [lamp];
  homeData.dashboards = [
    { ...homeDashboard, kind: "home", devices: [lamp.id] },
  ];
  await refresh();

  const bars = vi.mocked(topBar.TopBar);
  const frames = vi.mocked(shellFrame.ShellFrame);
  const places = vi.mocked(placePages.SidebarPlaces);
  expect(bars).toHaveBeenCalled();
  expect(frames).toHaveBeenCalled();
  bars.mockClear();
  frames.mockClear();
  places.mockClear();

  await act(async () => {
    pushLive({
      type: "device",
      id: lamp.id,
      device: { ...lamp, name: "Kitchen Lamp" },
    });
  });
  expect(
    container.querySelector('main [aria-label="Kitchen Lamp, Off"]'),
  ).not.toBeNull();
  expect(places).toHaveBeenCalled();
  expect(bars).not.toHaveBeenCalled();
  expect(frames).not.toHaveBeenCalled();
});

it("draws a room rename without redrawing the frame", async () => {
  homeData.devices = [light("lamp", "Lamp", { roomId: "kitchen" })];
  await refresh();

  const sidebar = container.querySelector("aside");
  expect(sidebar?.textContent).toContain("Kitchen");
  const frames = vi.mocked(shellFrame.ShellFrame);
  frames.mockClear();

  const places = placesSnapshot();
  await act(async () =>
    pushLive({
      type: "places",
      places: {
        ...places,
        rooms: [{ id: "kitchen", name: "Dining Room", floorId: null }],
      },
    }),
  );

  expect(sidebar?.textContent).toContain("Dining Room");
  expect(frames).not.toHaveBeenCalled();
});

it("keeps Apps from redrawing when a device changes", async () => {
  const lamp = light("lamp", "Lamp", { roomId: "kitchen" });
  homeData.devices = [lamp];
  await refresh();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('aside button[aria-label="Apps"]')!
      .click(),
  );

  const apps = vi.mocked(appsPage.AppsPage);
  const places = vi.mocked(placePages.SidebarPlaces);
  expect(apps).toHaveBeenCalled();
  apps.mockClear();
  places.mockClear();

  await act(async () =>
    pushLive({
      type: "device",
      id: lamp.id,
      device: { ...lamp, name: "Kitchen Lamp" },
    }),
  );
  expect(places).toHaveBeenCalled();
  expect(apps).not.toHaveBeenCalled();
});

it("dims Edit Home until the home has devices", async () => {
  homeData.devices = [];
  await refresh();
  const bars = vi.mocked(topBar.TopBar);
  expect(bars.mock.lastCall?.[0].onEditHome?.disabled).toBe(true);

  const lamp = light("lamp", "Lamp");
  await act(async () => {
    pushLive({ type: "device", id: lamp.id, device: lamp });
  });
  expect(bars.mock.lastCall?.[0].onEditHome?.disabled).toBe(false);
});

it("keeps Edit Home disabled while the first device snapshot is pending", async () => {
  const lamp = light("lamp", "Lamp");
  homeData.dashboards = [
    { ...homeDashboard, kind: "home", devices: [lamp.id] },
  ];
  let resolve!: (devices: DeviceInfo[]) => void;
  const snapshot = new Promise<DeviceInfo[]>((done) => {
    resolve = done;
  });
  const read = mockCoreJson.getMockImplementation()!;
  mockCoreJson.mockImplementation((path, init) =>
    path === "/api/devices" ? snapshot : read(path, init),
  );
  await remountHome();

  const bars = vi.mocked(topBar.TopBar);
  expect(bars.mock.lastCall?.[0].onEditHome?.disabled).toBe(true);

  await act(async () =>
    pushLive({ type: "device", id: lamp.id, device: lamp }),
  );
  expect(
    container.querySelector('main [aria-label="Lamp, Off"]'),
  ).not.toBeNull();
  expect(bars.mock.lastCall?.[0].onEditHome?.disabled).toBe(true);

  await act(async () => resolve([]));
  expect(bars.mock.lastCall?.[0].onEditHome?.disabled).toBe(false);
});

it("draws device detail only from opening through its exit fade", async () => {
  homeData.rooms = [{ id: "kitchen", name: "Kitchen", floorId: null }];
  const lamp = light("lamp", "Lamp", { roomId: "kitchen" });
  homeData.devices = [lamp];
  homeData.dashboards = [
    { ...homeDashboard, kind: "home", devices: [lamp.id] },
  ];
  await refresh();
  const details = vi.mocked(deviceDetail.DeviceDetail);
  details.mockClear();

  await act(async () =>
    pushLive({
      type: "device",
      id: lamp.id,
      device: { ...lamp, name: "Kitchen Lamp" },
    }),
  );
  expect(details).not.toHaveBeenCalled();

  withDeviceDetailFade();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        'main [aria-label="Kitchen Lamp, Off"]',
      )!
      .click(),
  );
  expect(details).toHaveBeenCalled();
  const opened = dialog()!;
  expect(opened).not.toBeNull();

  await pressDone(opened);
  expect(dialog()).toBe(opened);
  expect(opened.getAttribute("data-state")).toBe("closed");

  await finishFade(opened);
  expect(dialog()).toBeNull();
  details.mockClear();

  await act(async () =>
    pushLive({ type: "device", id: lamp.id, device: lamp }),
  );
  expect(
    container.querySelector('main [aria-label="Lamp, Off"]'),
  ).not.toBeNull();
  expect(details).not.toHaveBeenCalled();
});

it("keeps the player's artwork and tint visible through the exit fade", async () => {
  const hash = "a".repeat(64);
  const artwork = { url: "blob:artwork", colour: "oklch(0.4 0.1 80)" };
  vi.mocked(useArtwork).mockImplementation((requested) =>
    requested === hash ? artwork : null,
  );
  const player = mediaPlayer("player", "Speaker", "kitchen", {
    on: true,
    activity: "playing",
    media: { artwork: hash },
  });
  homeData.devices = [player];
  homeData.dashboards = [
    { ...homeDashboard, kind: "home", devices: [player.id] },
  ];
  await refresh();
  withDeviceDetailFade();

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('main [aria-label="Speaker, Playing"]')!
      .click(),
  );
  const opened = dialog()!;
  const image = () => opened.querySelector("img");
  const tint = () => opened.querySelector("[data-tint]:not(.opacity-0)");
  expect(image()?.getAttribute("src")).toBe(artwork.url);
  expect(tint()?.getAttribute("data-tint")).toBe(artwork.colour);

  await pressDone(opened);
  expect(dialog()).toBe(opened);
  expect(opened.getAttribute("data-state")).toBe("closed");
  expect(image()?.getAttribute("src")).toBe(artwork.url);
  expect(tint()?.getAttribute("data-tint")).toBe(artwork.colour);

  await finishFade(opened);
  expect(dialog()).toBeNull();
});
