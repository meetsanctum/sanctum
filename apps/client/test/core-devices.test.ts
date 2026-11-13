import type { CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { coreDevice, coreDevices } from "../src/core-devices";
import { coreJson } from "../src/core-fetch";
import { tilesOf } from "../src/device-tiles";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// Devices as the shell takes them from a core newer than it: the parts of a
// kind this build does not know are skipped where a device arrives.

const power: CapabilityInfo = {
  id: "power",
  kind: "switch",
  features: {},
  state: { on: true },
  observed: { on: true },
  desired: null,
  sync: "synced",
  setBy: null,
  changedAt: null,
};
const valve = {
  ...power,
  id: "valve",
  kind: "valve",
} as unknown as CapabilityInfo;
const device = (id: string, capabilities: CapabilityInfo[]): DeviceInfo => ({
  id,
  name: id,
  driverName: id,
  type: "plug",
  driver: "sanctum.example",
  manufacturer: null,
  model: null,
  roomId: null,
  availability: "online",
  lastSeenAt: null,
  firmware: null,
  probe: false,
  battery: null,
  leftAt: null,
  capabilities,
});
const tap = device("tap", [valve, power]);
const drain = device("drain", [valve]);

beforeEach(() => {
  vi.mocked(coreJson).mockReset();
});

describe("the home's devices", () => {
  it("come with the parts this build knows", async () => {
    vi.mocked(coreJson).mockResolvedValue([tap, drain]);

    const devices = await coreDevices();

    expect(coreJson).toHaveBeenCalledWith("/api/devices");
    expect(devices).toEqual([
      { ...tap, capabilities: [power] },
      { ...drain, capabilities: [] },
    ]);
  });

  it("have a tile for each part it knows, and one of its own for a device it knows nothing of", async () => {
    vi.mocked(coreJson).mockResolvedValue([tap, drain]);

    const tiles = tilesOf(await coreDevices(), undefined);

    expect(tiles.map((tile) => [tile.deviceId, tile.kind])).toEqual([
      ["tap", "switch"],
      ["drain", "unknown"],
    ]);
  });
});

describe("the device a route answers with", () => {
  it("comes with the parts this build knows", async () => {
    vi.mocked(coreJson).mockResolvedValue(tap);
    const init = { method: "POST", json: { id: "tap", name: "Tap" } };

    expect(await coreDevice("/api/devices/update", init)).toEqual({
      ...tap,
      capabilities: [power],
    });
    expect(coreJson).toHaveBeenCalledWith("/api/devices/update", init);
  });
});
