// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";

import * as roomSections from "../src/room-sections";
import { homeDashboard } from "./home-shell-fixtures";
import { container, homeData, pushLive, refresh } from "./home-shell-harness";
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
