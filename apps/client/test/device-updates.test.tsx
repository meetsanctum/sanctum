// @vitest-environment jsdom
import type { CapabilityInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { describe, expect, it } from "vitest";

import {
  capability,
  client,
  deferred,
  device,
  devices,
  live,
  pendingLoad,
  places,
  seed,
} from "./use-devices-harness";

describe("device updates", () => {
  it("are read when the shell refreshes its live feed, and followed over it", async () => {
    client.devices.mockResolvedValue([device(false)]);
    client.places.mockResolvedValue(places);
    await act(async () => {
      live.refresh();
    });
    expect(devices.tiles.map((tile) => [tile.name, tile.on])).toEqual([
      ["Switch", false],
    ]);
    await act(async () => {
      live.publish({ type: "device", id: "device", device: device(true) });
    });
    expect(devices.tiles[0]?.on).toBe(true);
  });

  it("keeps the tile of a device that didn't change, so it isn't drawn again", async () => {
    const other = { ...device(false), id: "other", name: "Other" };
    client.devices.mockResolvedValue([device(false), other]);
    client.places.mockResolvedValue(places);
    await act(async () => {
      live.refresh();
    });
    const [switched, unchanged] = devices.tiles;

    await act(async () => {
      live.publish({ type: "device", id: "device", device: device(true) });
    });
    expect(devices.tiles[0]).not.toBe(switched);
    expect(devices.tiles[0]?.on).toBe(true);
    expect(devices.tiles[1]).toBe(unchanged);

    await act(async () => {
      live.publish({
        type: "device",
        id: "other",
        device: { ...other, name: "Renamed" },
      });
    });
    expect(devices.tiles[1]).not.toBe(unchanged);
    expect(devices.tiles[1]?.name).toBe("Renamed");
  });

  it("keeps live state and places newer than an in-flight snapshot", async () => {
    const { snapshot, loading } = pendingLoad();
    const renamed = {
      ...places,
      rooms: [{ ...places.rooms[0]!, name: "Renamed" }],
    };
    await act(async () => {
      devices.apply({ type: "device", id: "device", device: device(true) });
      devices.apply({ type: "places", places: renamed });
      snapshot.resolve([device(false)]);
      await loading;
    });
    expect(devices.tiles[0]?.on).toBe(true);
    expect(devices.places).toEqual(renamed);
  });

  it("does not restore a device removed while a snapshot was loading", async () => {
    await seed();
    const { snapshot, loading } = pendingLoad();
    await act(async () => {
      devices.apply({ type: "device", id: "device", device: null });
      snapshot.resolve([device(false)]);
      await loading;
    });
    expect(devices.tiles).toEqual([]);
  });

  it("ignores an older snapshot that finishes after the latest refresh", async () => {
    const first = pendingLoad();
    const second = pendingLoad();
    await act(async () => {
      second.snapshot.resolve([device(true)]);
      await second.loading;
      first.snapshot.resolve([device(false)]);
      await first.loading;
    });
    expect(devices.tiles[0]?.on).toBe(true);
  });

  it("keeps a live confirmation newer than a delayed command response", async () => {
    await seed();
    const response = deferred<CapabilityInfo>();
    client.command.mockReturnValue(response.promise);
    let command!: Promise<void>;
    act(() => {
      command = devices.toggle(devices.tiles[0]!);
    });
    await act(async () => {
      devices.apply({ type: "device", id: "device", device: device(false) });
      response.resolve(capability(true));
      await command;
    });
    expect(devices.tiles[0]?.on).toBe(false);
  });

  it("keeps a successful command when an older snapshot arrives afterwards", async () => {
    await seed();
    const { snapshot, loading } = pendingLoad();
    client.command.mockResolvedValue(capability(true));
    await act(async () => {
      await devices.toggle(devices.tiles[0]!);
    });
    await act(async () => {
      snapshot.resolve([device(false)]);
      await loading;
    });
    expect(devices.tiles[0]?.on).toBe(true);
  });

  it("sends a brightness as a light command, and a switch only on or off", async () => {
    await seed();
    client.command.mockResolvedValue(capability(true));
    await act(async () => {
      await devices.dim(devices.tiles[0]!, 40);
    });
    expect(client.command).toHaveBeenCalledWith({
      device: "device",
      capability: "switch",
      command: { on: true },
    });
  });

  it("switches a room's lights through the core", async () => {
    client.lights.mockResolvedValue({ on: false, switched: 2, failed: [] });
    await act(async () => {
      await devices.switchLights({ kind: "room", id: "room" }, []);
    });
    expect(client.lights).toHaveBeenCalledWith({
      place: { kind: "room", id: "room" },
      to: "toggle",
    });
  });
});
