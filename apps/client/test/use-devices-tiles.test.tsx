// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";

import * as deviceTiles from "../src/device-tiles";
import { device, devices, places } from "./use-devices-harness";

vi.mock(import("../src/device-tiles"), async (original) => {
  const actual = await original();
  return { ...actual, tilesOf: vi.fn(actual.tilesOf) };
});

// One device's change makes only its own tiles again; the others keep theirs.

it("makes only the changed device's tiles again", async () => {
  const other = { ...device(false), id: "other", name: "Other" };
  await act(async () => {
    devices.apply({ type: "places", places });
    devices.apply({ type: "device", id: "device", device: device(false) });
    devices.apply({ type: "device", id: "other", device: other });
  });
  const before = devices.tiles.find((tile) => tile.deviceId === "other");
  const made = vi.mocked(deviceTiles.tilesOf);
  made.mockClear();

  await act(async () => {
    devices.apply({ type: "device", id: "device", device: device(true) });
  });

  expect(made.mock.calls.map(([shown]) => shown.map(({ id }) => id))).toEqual([
    ["device"],
  ]);
  expect(devices.tiles.find((tile) => tile.deviceId === "device")?.on).toBe(
    true,
  );
  expect(devices.tiles.find((tile) => tile.deviceId === "other")).toBe(before);
});

it("makes them again when the places change", async () => {
  await act(async () => {
    devices.apply({ type: "places", places });
    devices.apply({ type: "device", id: "device", device: device(false) });
  });
  const made = vi.mocked(deviceTiles.tilesOf);
  made.mockClear();

  await act(async () => {
    devices.apply({
      type: "places",
      places: { ...places, rooms: [] },
    });
  });

  expect(made).toHaveBeenCalledTimes(1);
  expect(devices.tiles[0]?.roomId).toBeNull();
});
