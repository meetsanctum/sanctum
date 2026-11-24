// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";

// Load the harness first so the screen uses its data fixtures.
import { container, homeData, pushLive, refresh } from "./home-shell-harness";
import * as topBar from "../src/top-bar";
import * as placePages from "../src/place-pages";
import { homeDashboard } from "./home-shell-fixtures";
import { light } from "./settings-devices-fixtures";

vi.mock(import("../src/top-bar"), async (original) => {
  const actual = await original();
  return { ...actual, TopBar: vi.fn(actual.TopBar) };
});
vi.mock(import("../src/place-pages"), async (original) => {
  const actual = await original();
  return { ...actual, SidebarPlaces: vi.fn(actual.SidebarPlaces) };
});

// The devices are held around the signed-in screen: a device's change draws
// the page and the sidebar's places, not the top bar around them.

it("draws a device's change without the top bar", async () => {
  homeData.rooms = [{ id: "kitchen", name: "Kitchen", floorId: null }];
  const lamp = light("lamp", "Lamp", { roomId: "kitchen" });
  homeData.devices = [lamp];
  homeData.dashboards = [
    { ...homeDashboard, kind: "home", devices: [lamp.id] },
  ];
  await refresh();

  const bars = vi.mocked(topBar.TopBar);
  const places = vi.mocked(placePages.SidebarPlaces);
  expect(bars).toHaveBeenCalled();
  bars.mockClear();
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
