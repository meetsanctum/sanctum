// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";

import * as deviceTiles from "../src/device-tiles";
import { remote } from "./device-tiles-fixtures";
import { contactSensor } from "./place-pages-fixtures";
import {
  capability,
  client,
  deferred,
  device,
  devices,
  places,
  seed,
} from "./use-devices-harness";

vi.mock(import("../src/device-tiles"), async (original) => {
  const actual = await original();
  return { ...actual, tilesOfDevice: vi.fn(actual.tilesOfDevice) };
});

afterEach(() => vi.useRealTimers());

// One device's change makes only its own tiles again; the others keep theirs.

it("makes only the changed device's tiles again", async () => {
  const other = { ...device(false), id: "other", name: "Other" };
  await act(async () => {
    devices.apply({ type: "places", places });
    devices.apply({ type: "device", id: "device", device: device(false) });
    devices.apply({ type: "device", id: "other", device: other });
  });
  const before = devices.tiles.find((tile) => tile.deviceId === "other");
  const made = vi.mocked(deviceTiles.tilesOfDevice);
  made.mockClear();

  await act(async () => {
    devices.apply({ type: "device", id: "device", device: device(true) });
  });

  expect(made.mock.calls.map(([shown]) => shown.id)).toEqual(["device"]);
  expect(devices.tiles.find((tile) => tile.deviceId === "device")?.on).toBe(
    true,
  );
  expect(devices.tiles.find((tile) => tile.deviceId === "other")).toBe(before);
});

it("reuses a pending switch's tiles when another device changes", async () => {
  await seed();
  const other = { ...device(false), id: "other", name: "Other" };
  await act(async () =>
    devices.apply({ type: "device", id: other.id, device: other }),
  );
  const answer = deferred<ReturnType<typeof capability>>();
  client.command.mockReturnValueOnce(answer.promise);
  let toggling!: Promise<void>;
  act(() => {
    toggling = devices.toggle(devices.tiles[0]!);
  });
  const pending = devices.tiles[0];
  expect(pending).toMatchObject({ on: true, status: "On" });
  const made = vi.mocked(deviceTiles.tilesOfDevice);
  made.mockClear();

  await act(async () =>
    devices.apply({
      type: "device",
      id: other.id,
      device: { ...other, name: "Other switch" },
    }),
  );
  expect(made.mock.calls.map(([shown]) => shown.id)).toEqual([other.id]);
  expect(devices.tiles[0]).toBe(pending);
  await act(async () => {
    answer.resolve(capability(true));
    await toggling;
  });
});

it("updates a contact tile's elapsed time between clock ticks", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-31T12:01:00Z"));
  const door = contactSensor(
    "door",
    "Door",
    "room",
    true,
    "2026-10-31T12:00:30Z",
  );
  await seed();
  await act(async () =>
    devices.apply({ type: "device", id: door.id, device: door }),
  );
  const doorStatus = () =>
    devices.tiles.find((tile) => tile.deviceId === door.id)?.status;
  expect(doorStatus()).toBe("Open");

  vi.setSystemTime(new Date("2026-10-31T12:01:35Z"));
  await act(async () =>
    devices.apply({ type: "device", id: "device", device: device(true) }),
  );
  expect(doorStatus()).toBe("Open for 1 min");
});

it("makes only the pressed button's device tiles again", async () => {
  const button = remote("remote", "Remote", "room");
  const other = remote("other", "Other remote", "room");
  await seed();
  await act(async () => {
    devices.apply({ type: "device", id: button.id, device: button });
    devices.apply({ type: "device", id: other.id, device: other });
  });
  const made = vi.mocked(deviceTiles.tilesOfDevice);
  made.mockClear();

  await act(async () =>
    devices.apply({
      type: "press",
      device: button.id,
      capability: "button",
      action: "single",
      at: new Date().toISOString(),
      isCaptured: false,
    }),
  );
  expect(made.mock.calls.map(([shown]) => shown.id)).toEqual([button.id]);
  expect(devices.tiles.find((tile) => tile.deviceId === button.id)?.on).toBe(
    true,
  );
});

it("makes them again when the places change", async () => {
  await act(async () => {
    devices.apply({ type: "places", places });
    devices.apply({ type: "device", id: "device", device: device(false) });
  });
  const made = vi.mocked(deviceTiles.tilesOfDevice);
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
