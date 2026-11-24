// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";

// Load the harness first so room sections use its data fixtures.
import { container, homeData, pushLive, refresh } from "./home-shell-harness";
import * as roomSections from "../src/room-sections";
import { homeDashboard } from "./home-shell-fixtures";
import { moods, relax, sensor } from "./place-pages-fixtures";
import { light } from "./settings-devices-fixtures";

vi.mock(import("../src/room-sections"), async (original) => {
  const actual = await original();
  return { ...actual, RoomRow: vi.fn(actual.RoomRow) };
});

// A room on Home draws again only when what it shows changes.

it("redraws only the room whose device changes", async () => {
  homeData.rooms = [
    { id: "kitchen", name: "Kitchen", floorId: null },
    { id: "office", name: "Office", floorId: null },
  ];
  const lamp = light("lamp", "Lamp", { roomId: "kitchen" });
  const desk = light("desk", "Desk", { roomId: "office" });
  homeData.devices = [lamp, desk];
  homeData.dashboards = [
    { ...homeDashboard, kind: "home", devices: [lamp.id, desk.id] },
  ];
  await refresh();

  const rows = vi.mocked(roomSections.RoomRow);
  const drawn = () => rows.mock.calls.map(([props]) => props.roomName);
  expect(drawn()).toEqual(expect.arrayContaining(["Kitchen", "Office"]));
  rows.mockClear();

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
  expect(drawn()).toEqual(["Kitchen"]);
});

it("redraws only the room whose sensor reading changes without a tile on Home", async () => {
  homeData.rooms = [
    { id: "kitchen", name: "Kitchen", floorId: null },
    { id: "office", name: "Office", floorId: null },
  ];
  const lamp = light("lamp", "Lamp", { roomId: "kitchen" });
  const desk = light("desk", "Desk", { roomId: "office" });
  const thermometer = sensor("kitchen-sensor", "kitchen", 21.5, 48);
  homeData.devices = [lamp, desk, thermometer];
  homeData.dashboards = [
    { ...homeDashboard, kind: "home", devices: [lamp.id, desk.id] },
  ];
  await refresh();

  const readings = container.querySelector(
    '[aria-labelledby="home-kitchen"] [data-slot="readings"]',
  );
  expect(readings?.textContent).toContain("21.5°");
  const rows = vi.mocked(roomSections.RoomRow);
  rows.mockClear();

  await act(async () => {
    pushLive({
      type: "device",
      id: thermometer.id,
      device: sensor(thermometer.id, "kitchen", 22, 48),
    });
  });
  expect(readings?.textContent).toContain("22°");
  expect(rows.mock.calls.map(([props]) => props.roomName)).toEqual(["Kitchen"]);
});

it("redraws only the room whose mood changes", async () => {
  homeData.rooms = [
    { id: "kitchen", name: "Kitchen", floorId: null },
    { id: "office", name: "Office", floorId: null },
  ];
  homeData.devices = [
    light("lamp", "Lamp", { roomId: "kitchen" }),
    light("desk", "Desk", { roomId: "office" }),
  ];
  homeData.installed = [moods];
  homeData.entities = [relax];
  await refresh();

  const mood = container.querySelector('main [aria-label="Relax in Office"]');
  expect(mood?.getAttribute("aria-pressed")).toBe("true");
  const rows = vi.mocked(roomSections.RoomRow);
  rows.mockClear();

  await act(async () => {
    pushLive({
      type: "entity",
      app: relax.app,
      key: relax.key,
      was: relax.type,
      entity: {
        ...relax,
        state: { ...(relax.state as object), active: false },
      },
    });
  });
  expect(mood?.getAttribute("aria-pressed")).toBe("false");
  expect(rows.mock.calls.map(([props]) => props.roomName)).toEqual(["Office"]);
});
