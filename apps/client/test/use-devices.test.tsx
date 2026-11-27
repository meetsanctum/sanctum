// @vitest-environment jsdom
import type {
  CapabilityInfo,
  DeviceInfo,
  LightsResult,
} from "@meetsanctum/app-sdk";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { light } from "./place-pages-fixtures";
import {
  capability,
  client,
  deferred,
  device,
  devices,
  pendingLoad,
  places,
  seed,
} from "./use-devices-harness";

describe("failed commands", () => {
  it("mark the tile each time, and still fail for the caller", async () => {
    await seed();
    client.command.mockRejectedValue(new Error("unavailable"));
    for (const failures of [1, 2]) {
      await act(async () => {
        await expect(devices.toggle(devices.tiles[0]!)).rejects.toThrow();
      });
      expect(devices.tiles[0]!.failures).toBe(failures);
      expect(devices.tiles[0]!.on).toBe(false);
    }
  });

  it("mark the lights the core could not switch", async () => {
    await seed();
    client.lights.mockResolvedValue({
      on: true,
      switched: 0,
      failed: [{ device: "device", capability: "switch" }],
    });
    await act(async () => {
      await devices.switchLights({ kind: "home" }, devices.tiles);
    });
    expect(devices.tiles[0]!.failures).toBe(1);
  });

  // The switch is off; turning it on waits for the device, which either
  // confirms it or never answers.
  const waiting = {
    ...capability(false),
    state: { on: true },
    desired: { on: true },
    sync: "pending",
    setBy: null,
    changedAt: null,
  } as CapabilityInfo;
  const unanswered: CapabilityInfo = { ...capability(false), sync: "conflict" };
  const live = (each: CapabilityInfo) => ({
    type: "device" as const,
    id: "device",
    device: { ...device(false), capabilities: [each] },
  });

  it.each(["synced", "conflict"] as const)(
    "ignores an older %s snapshot when following a pending command",
    async (sync) => {
      await seed();
      const { snapshot, loading } = pendingLoad();
      client.command.mockResolvedValue(waiting);
      await act(async () => {
        await devices.toggle(devices.tiles[0]!);
        devices.apply(live(waiting));
      });
      await act(async () => {
        snapshot.resolve([
          { ...device(false), capabilities: [{ ...capability(false), sync }] },
        ]);
        await loading;
      });
      expect(devices.tiles[0]!.failures).toBeUndefined();
      expect(devices.tiles[0]).toMatchObject({ on: true, status: "On" });
      await act(async () => {
        devices.apply(live(unanswered));
      });
      expect(devices.tiles[0]!.failures).toBe(1);
    },
  );

  it("mark a command from here the device never confirms", async () => {
    await seed();
    client.command.mockResolvedValue(waiting);
    await act(async () => {
      await devices.toggle(devices.tiles[0]!);
    });
    expect(devices.tiles[0]!.failures).toBeUndefined();
    await act(async () => {
      devices.apply(live(unanswered));
    });
    expect(devices.tiles[0]!.failures).toBe(1);
    expect(devices.tiles[0]!.status).toBe("Not responding");
  });

  it("mark a command from here that went again and slowly, once", async () => {
    await seed();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    client.command.mockResolvedValue(waiting);
    await act(async () => {
      await devices.toggle(devices.tiles[0]!);
      devices.apply(live(waiting));
    });
    // Two slow deliveries and two waits later, the core gives up.
    now.mockReturnValue(1_075_000);
    await act(async () => {
      devices.apply(live(unanswered));
      devices.apply(live(unanswered));
    });
    expect(devices.tiles[0]!.failures).toBe(1);
    now.mockRestore();
  });

  it("leave a command the device confirms alone", async () => {
    await seed();
    client.command.mockResolvedValue(waiting);
    await act(async () => {
      await devices.toggle(devices.tiles[0]!);
    });
    await act(async () => {
      devices.apply(live(capability(true)));
    });
    // A later miss belongs to someone else's command.
    await act(async () => {
      devices.apply(live(waiting));
      devices.apply(live(unanswered));
    });
    expect(devices.tiles[0]!.failures).toBeUndefined();
  });

  it("end a command the core answers as confirmed already", async () => {
    await seed();
    client.command.mockResolvedValue(capability(true));
    await act(async () => {
      await devices.toggle(devices.tiles[0]!);
    });
    // Someone else's command right after goes unconfirmed.
    await act(async () => {
      devices.apply(live(waiting));
      devices.apply(live(unanswered));
    });
    expect(devices.tiles[0]!.failures).toBeUndefined();
  });

  it("leave another client's unconfirmed command alone", async () => {
    await seed();
    await act(async () => {
      devices.apply(live(waiting));
    });
    await act(async () => {
      devices.apply(live(unanswered));
    });
    expect(devices.tiles[0]!.failures).toBeUndefined();
  });

  it("mark a light the core switched that never confirms", async () => {
    await seed();
    client.lights.mockResolvedValue({ on: true, switched: 1, failed: [] });
    await act(async () => {
      await devices.switchLights({ kind: "home" }, devices.tiles);
    });
    await act(async () => {
      devices.apply(live(waiting));
    });
    await act(async () => {
      devices.apply(live(unanswered));
    });
    expect(devices.tiles[0]!.failures).toBe(1);
  });

  it("follow states that arrive in one render", async () => {
    await seed();
    const answer = deferred<CapabilityInfo>();
    client.command.mockReturnValue(answer.promise);
    let toggling!: Promise<void>;
    act(() => {
      toggling = devices.toggle(devices.tiles[0]!);
    });
    await act(async () => {
      devices.apply(live(waiting));
      devices.apply(live(unanswered));
    });
    expect(devices.tiles[0]!.failures).toBe(1);
    expect(devices.tiles[0]).toMatchObject({
      on: false,
      status: "Not responding",
    });
    await act(async () => {
      answer.resolve(waiting);
      await toggling;
    });
    expect(devices.tiles[0]!.failures).toBe(1);
  });

  it("leave a miss after a confirmation in the same render alone", async () => {
    await seed();
    const answer = deferred<CapabilityInfo>();
    client.command.mockReturnValue(answer.promise);
    let toggling!: Promise<void>;
    act(() => {
      toggling = devices.toggle(devices.tiles[0]!);
    });
    await act(async () => {
      devices.apply(live(waiting));
      devices.apply(live(capability(true)));
      devices.apply(live(waiting));
      devices.apply(live(unanswered));
      answer.resolve(waiting);
      await toggling;
    });
    expect(devices.tiles[0]!.failures).toBeUndefined();
  });

  it("keep following a newer command when an older one fails", async () => {
    await seed();
    const older = deferred<CapabilityInfo>();
    client.command
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(waiting);
    let first!: Promise<void>;
    act(() => {
      first = devices.dim(devices.tiles[0]!, 30);
    });
    await act(async () => {
      await devices.dim(devices.tiles[0]!, 60);
    });
    await act(async () => {
      older.resolve(Promise.reject(new Error("unavailable")) as never);
      await expect(first).rejects.toThrow();
    });
    expect(devices.tiles[0]!.failures).toBe(1);
    await act(async () => {
      devices.apply(live(unanswered));
    });
    expect(devices.tiles[0]!.failures).toBe(2);
  });

  it("fail a retry the core could not deliver once", async () => {
    await seed();
    await act(async () => {
      devices.apply(live(unanswered));
    });
    const answer = deferred<CapabilityInfo>();
    client.command.mockReturnValue(answer.promise);
    let toggling!: Promise<void>;
    act(() => {
      toggling = devices.toggle(devices.tiles[0]!);
    });
    // The core shows the command, then puts back the conflict from before.
    await act(async () => {
      devices.apply(live(waiting));
      devices.apply(live(unanswered));
      answer.resolve(Promise.reject(new Error("unavailable")) as never);
      await expect(toggling).rejects.toThrow();
    });
    expect(devices.tiles[0]!.failures).toBe(1);
  });

  it("leave a colour held for a light that is off alone", async () => {
    await seed();
    client.command.mockResolvedValue(waiting);
    await act(async () => {
      await devices.toggle(devices.tiles[0]!);
    });
    await act(async () => {
      devices.apply(live({ ...waiting, sync: "held" }));
      devices.apply(live(waiting));
      devices.apply(live(unanswered));
    });
    expect(devices.tiles[0]!.failures).toBeUndefined();
  });

  it("forget the commands of a device that went", async () => {
    await seed();
    client.command.mockResolvedValue(waiting);
    await act(async () => {
      await devices.toggle(devices.tiles[0]!);
    });
    await act(async () => {
      devices.apply({ type: "device", id: "device", device: null });
      devices.apply(live(waiting));
      devices.apply(live(unanswered));
    });
    expect(devices.tiles[0]!.failures).toBeUndefined();
  });

  it("forget a command that never showed as pending", async () => {
    await seed();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    client.lights.mockResolvedValue({ on: true, switched: 0, failed: [] });
    await act(async () => {
      await devices.switchLights({ kind: "home" }, devices.tiles);
    });
    // Much later, someone else's command goes unconfirmed.
    now.mockReturnValue(1_011_000);
    await act(async () => {
      devices.apply(live(waiting));
      devices.apply(live(unanswered));
    });
    expect(devices.tiles[0]!.failures).toBeUndefined();
    now.mockRestore();
  });

  it("follow every light the core might switch", async () => {
    await seed();
    await act(async () => {
      devices.apply({
        type: "device",
        id: "other",
        device: { ...device(true), id: "other" },
      });
    });
    // The tiles say one is on, so toggling turns lights off, yet the core
    // knows better and turns the other one on.
    client.lights.mockResolvedValue({ on: true, switched: 1, failed: [] });
    await act(async () => {
      await devices.switchLights({ kind: "home" }, devices.tiles);
    });
    await act(async () => {
      devices.apply(live(waiting));
      devices.apply(live(unanswered));
    });
    expect(devices.tiles.map((tile) => tile.failures)).toEqual([1, undefined]);
  });

  it("mark each light a failed call would have switched", async () => {
    await seed();
    await act(async () => {
      devices.apply({
        type: "device",
        id: "other",
        device: { ...device(true), id: "other" },
      });
    });
    client.lights.mockRejectedValue(new Error("unavailable"));
    await act(async () => {
      await expect(
        devices.switchLights({ kind: "home" }, devices.tiles, "on"),
      ).rejects.toThrow();
    });
    // The other one was on already.
    expect(devices.tiles.map((tile) => tile.failures)).toEqual([1, undefined]);
  });
});

describe("commands from here", () => {
  function showLight(
    id: string,
    brightness: number | null,
    sync: "synced" | "pending" | "conflict" = "synced",
    color = false,
  ) {
    const lamp = light(id, id, "room", brightness !== null);
    const capability = lamp.capabilities[0]!;
    if (capability.kind !== "light") throw new Error("Expected a light");
    const state =
      brightness === null ? { on: false } : { on: true, brightness };
    devices.apply({
      type: "device",
      id,
      device: {
        ...lamp,
        capabilities: [
          {
            ...capability,
            features: { ...capability.features, color },
            state,
            sync,
          },
        ],
      },
    });
  }

  it("previews room brightness and restores only the light that failed delivery", async () => {
    act(() => {
      devices.apply({ type: "places", places });
      showLight("desk", 60);
      showLight("shelf", 80);
    });
    const result = deferred<LightsResult>();
    client.lights.mockReturnValue(result.promise);
    let setting!: Promise<LightsResult>;
    act(() => {
      setting = devices.setLights({ kind: "room", id: "room" }, devices.tiles, {
        brightness: 30,
      });
    });
    expect(devices.tiles.map((tile) => tile.brightness)).toEqual([30, 30]);

    await act(async () => {
      showLight("shelf", 30);
      result.resolve({
        on: true,
        switched: 1,
        failed: [{ device: "desk", capability: "light" }],
      });
      await setting;
    });
    expect(
      devices.tiles.map(({ brightness, failures }) => [brightness, failures]),
    ).toEqual([
      [60, 1],
      [30, undefined],
    ]);
  });

  it("sends a room's colour to the lights that are off too, and fails one that could not take it", async () => {
    act(() => {
      devices.apply({ type: "places", places });
      showLight("desk", 60, "synced", true);
      showLight("shelf", null, "synced", true);
    });
    const result = deferred<LightsResult>();
    client.lights.mockReturnValue(result.promise);
    let setting!: Promise<LightsResult>;
    act(() => {
      setting = devices.setLights({ kind: "room", id: "room" }, devices.tiles, {
        hue: 220,
        saturation: 100,
      });
    });
    await act(async () => {
      result.resolve({
        on: true,
        switched: 1,
        failed: [{ device: "shelf", capability: "light" }],
      });
      await setting;
    });
    expect(
      devices.tiles.map(({ deviceId, failures }) => [deviceId, failures]),
    ).toEqual([
      ["desk", undefined],
      ["shelf", 1],
    ]);
  });

  it("still marks a dim-only light when it fails to turn off after a room colour is picked", async () => {
    const place = { kind: "room", id: "room" } as const;
    act(() => {
      devices.apply({ type: "places", places });
      showLight("desk", 60);
      showLight("shelf", null, "synced", true);
    });
    client.lights.mockResolvedValueOnce({ on: false, switched: 1, failed: [] });
    await act(async () => {
      await devices.switchLights(place, devices.tiles, "off");
      showLight("desk", null, "pending");
    });

    client.lights.mockResolvedValueOnce({ on: true, switched: 1, failed: [] });
    await act(async () => {
      await devices.setLights(place, devices.tiles, {
        hue: 220,
        saturation: 100,
      });
      showLight("desk", 60, "conflict");
    });
    expect(
      devices.tiles.find((tile) => tile.deviceId === "desk")?.failures,
    ).toBe(1);
  });

  it.each([true, false])(
    "reports a late room failure once only if all deliveries fail to confirm (%s)",
    async (allFail) => {
      act(() => {
        devices.apply({ type: "places", places });
        showLight("desk", 60);
        showLight("shelf", 80);
      });
      const result = deferred<LightsResult>();
      client.lights.mockReturnValue(result.promise);
      let setting!: Promise<LightsResult>;
      const failureKey = "room-lights:room";
      act(() => {
        setting = devices.setLights(
          { kind: "room", id: "room" },
          devices.tiles,
          { brightness: 30 },
          failureKey,
        );
        showLight("desk", 30, "pending");
        showLight("shelf", 30, "pending");
        showLight("desk", 60, "conflict");
      });
      expect(devices.failures.get(failureKey)).toBeUndefined();
      await act(async () => {
        result.resolve({ on: true, switched: 2, failed: [] });
        await setting;
      });
      expect(devices.failures.get(failureKey)).toBeUndefined();

      act(() => {
        showLight("shelf", allFail ? 80 : 30, allFail ? "conflict" : "synced");
        showLight("desk", 60, "conflict");
      });
      expect(devices.failures.get(failureKey)).toBe(allFail ? 1 : undefined);
    },
  );
  it("show on the tile as they will be before the core answers", async () => {
    await seed();
    const response = deferred<CapabilityInfo>();
    client.command.mockReturnValue(response.promise);
    let command!: Promise<void>;
    act(() => {
      command = devices.toggle(devices.tiles[0]!);
    });
    expect(devices.tiles[0]).toMatchObject({ on: true, status: "On" });

    await act(async () => {
      response.resolve(capability(true));
      await command;
    });
    expect(devices.tiles[0]).toMatchObject({ on: true, status: "On" });
  });

  it("go back to the device as it was when the core cannot take them", async () => {
    await seed();
    const response = deferred<CapabilityInfo>();
    client.command.mockReturnValue(
      response.promise.then(() => Promise.reject(new Error("unavailable"))),
    );
    let command!: Promise<void>;
    act(() => {
      command = devices.toggle(devices.tiles[0]!);
    });
    expect(devices.tiles[0]?.on).toBe(true);

    await act(async () => {
      response.resolve(capability(true));
      await expect(command).rejects.toThrow();
    });
    expect(devices.tiles[0]).toMatchObject({
      on: false,
      status: "Off",
      failures: 1,
    });
  });

  it.each(["synced", "pending"] as const)(
    "keeps a later command over an older %s snapshot and answer",
    async (sync) => {
      await seed();
      const first = deferred<CapabilityInfo>();
      const second = deferred<CapabilityInfo>();
      client.command
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      let commands!: Promise<void>[];
      act(() => {
        commands = [devices.toggle(devices.tiles[0]!)];
      });
      act(() => {
        commands.push(devices.toggle(devices.tiles[0]!));
      });
      // Off, as the switch still is.
      expect(devices.tiles[0]?.on).toBe(false);

      // An unchanged snapshot cannot acknowledge the second command. The
      // first command's pending update can still be on its way.
      const { snapshot, loading } = pendingLoad();
      await act(async () => {
        snapshot.resolve([
          { ...device(false), capabilities: [{ ...capability(false), sync }] },
        ]);
        await loading;
        devices.apply({
          type: "device",
          id: "device",
          device: {
            ...device(true),
            capabilities: [
              { ...capability(true), sync: "pending", desired: { on: true } },
            ],
          },
        });
      });
      expect(devices.tiles[0]?.on).toBe(false);

      await act(async () => {
        first.resolve(capability(true));
        await commands[0];
      });
      expect(devices.tiles[0]?.on).toBe(false);

      await act(async () => {
        devices.apply({ type: "device", id: "device", device: device(false) });
        second.resolve(capability(false));
        await commands[1];
      });
      expect(devices.tiles[0]).toMatchObject({ on: false, status: "Off" });
    },
  );

  it("show a room's lights off before the core answers", async () => {
    await seed();
    act(() =>
      devices.apply({ type: "device", id: "device", device: device(true) }),
    );
    const result = deferred<LightsResult>();
    client.lights.mockReturnValue(result.promise);
    let switching!: Promise<LightsResult>;
    act(() => {
      switching = devices.switchLights(
        { kind: "room", id: "room" },
        devices.tiles,
      );
    });
    expect(devices.tiles[0]).toMatchObject({ on: false, status: "Off" });

    await act(async () => {
      result.resolve({ on: false, switched: 1, failed: [] });
      devices.apply({ type: "device", id: "device", device: device(false) });
      await switching;
    });
    expect(devices.tiles[0]).toMatchObject({ on: false, status: "Off" });
  });

  it("drop a room's turning off once it is turned on again before the core answers", async () => {
    await seed();
    act(() =>
      devices.apply({ type: "device", id: "device", device: device(true) }),
    );
    const off = deferred<LightsResult>();
    const on = deferred<LightsResult>();
    client.lights
      .mockReturnValueOnce(off.promise)
      .mockReturnValueOnce(on.promise);
    let switching!: Promise<LightsResult>[];
    act(() => {
      switching = [
        devices.switchLights({ kind: "room", id: "room" }, devices.tiles),
      ];
    });
    expect(devices.tiles[0]).toMatchObject({ on: false, status: "Off" });

    act(() => {
      switching.push(
        devices.switchLights({ kind: "room", id: "room" }, devices.tiles, "on"),
      );
    });
    // The core still shows the light on, and it stays so.
    expect(devices.tiles[0]).toMatchObject({ on: true, status: "On" });

    await act(async () => {
      off.resolve({ on: false, switched: 1, failed: [] });
      on.resolve({ on: true, switched: 1, failed: [] });
      await Promise.all(switching);
    });
    expect(devices.tiles[0]).toMatchObject({ on: true, status: "On" });
  });

  it("lets the core choose which lights a room's turn-on rule leaves off", async () => {
    const light = (id: string, on: boolean): DeviceInfo => ({
      ...device(on),
      id,
      capabilities: [
        {
          ...capability(on),
          kind: "light",
          features: { brightness: false, colorTemperature: null, color: false },
        },
      ],
    });
    act(() => {
      devices.apply({ type: "places", places });
      for (const id of ["device", "other"]) {
        devices.apply({ type: "device", id, device: light(id, false) });
      }
    });
    const result = deferred<LightsResult>();
    client.lights.mockReturnValue(result.promise);
    let switching!: Promise<LightsResult>;
    act(() => {
      switching = devices.switchLights(
        { kind: "room", id: "room" },
        devices.tiles,
        "on",
      );
    });
    expect(devices.tiles[0]).toMatchObject({ on: false, status: "Off" });
    await act(async () => {
      devices.apply({
        type: "device",
        id: "other",
        device: light("other", true),
      });
      result.resolve({ on: true, switched: 1, failed: [] });
      await switching;
    });
    expect(devices.tiles[0]).toMatchObject({ on: false, status: "Off" });
    expect(devices.tiles[1]).toMatchObject({ on: true, status: "On" });
  });
});
