import type { DeviceInfo, FirmwareInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  batteriesTile,
  batteryOrder,
  dueBatteries,
  maintenanceHint,
  sinceWords,
  updatesOf,
} from "../src/maintenance";

// Maintenance: which devices are due, in which order, and how Settings and
// the dashboard's tile say it.

// A Saturday, at midday so every time zone near it has the same day.
const now = Date.parse("2026-10-31T12:00:00Z");

function firmware(extra: Partial<FirmwareInfo> = {}): FirmwareInfo {
  return {
    version: "1.0",
    updatable: true,
    sleeps: false,
    state: "current",
    progress: null,
    remainingSeconds: null,
    problem: null,
    checkedAt: null,
    startedAt: null,
    endedAt: null,
    ...extra,
  };
}

function device(
  id: string,
  name: string,
  extra: Partial<DeviceInfo> = {},
): DeviceInfo {
  return {
    id,
    name,
    driver: "sanctum.zigbee",
    driverName: "Wireless mini switch",
    type: "button",
    manufacturer: "Aqara",
    model: "WXKG11LM",
    roomId: "office",
    availability: "online",
    lastSeenAt: "2026-10-31T11:00:00Z",
    capabilities: [],
    firmware: firmware({ updatable: false, sleeps: true }),
    probe: false,
    identify: false,
    battery: 64,
    batteryLow: null,
    shownAs: null,
    leftAt: null,
    problem: null,
    ...extra,
  };
}

const quiet = device("button", "Office button", {
  availability: "unknown",
  lastSeenAt: "2026-10-27T09:10:00Z",
  battery: 6,
});
const low = device("hall", "Hall sensor", { battery: 8 });
const kitchen = device("kitchen", "Kitchen button", { battery: 64 });
// Each says itself that its battery is low: one at a charge that isn't,
// one without a charge.
const flagged = device("porch", "Porch door", {
  battery: 63,
  batteryLow: true,
});
const unfigured = device("shed", "Shed door", {
  battery: null,
  batteryLow: true,
});
const waiting = device("new", "Kitchen sensor", { battery: null });
const lamp = (name: string, extra: Partial<FirmwareInfo>) =>
  device(name, name, { battery: null, firmware: firmware(extra) });

describe("when a device was last heard from", () => {
  it("is yesterday, a weekday this week, or a date", () => {
    expect(sinceWords("2026-10-30T09:00:00Z", now)).toBe("yesterday");
    expect(sinceWords("2026-10-27T09:10:00Z", now)).toBe("Tuesday");
    expect(sinceWords("2026-10-12T09:00:00Z", now)).toBe("12 October");
  });
});

describe("batteries", () => {
  it("come quiet first, then lowest first, then those that haven't said", () => {
    const mains = lamp("Desk lamp", {});
    expect(
      batteryOrder([kitchen, waiting, mains, low, quiet], now).map(
        (each) => each.name,
      ),
    ).toEqual([
      "Office button",
      "Hall sensor",
      "Kitchen button",
      "Kitchen sensor",
    ]);
    expect(
      dueBatteries([kitchen, waiting, low, quiet], now).map((each) => each.id),
    ).toEqual(["button", "hall"]);
  });

  it("count one whose device says its battery is low, after the low charges", () => {
    expect(
      batteryOrder([kitchen, unfigured, waiting, flagged, low, quiet], now).map(
        (each) => each.name,
      ),
    ).toEqual([
      "Office button",
      "Hall sensor",
      "Porch door",
      "Shed door",
      "Kitchen button",
      "Kitchen sensor",
    ]);
    expect(
      dueBatteries([kitchen, unfigured, flagged], now).map((each) => each.id),
    ).toEqual(["porch", "shed"]);
    expect(maintenanceHint([flagged, unfigured, kitchen], now)).toBe(
      "2 batteries",
    );
  });

  it("keep one that says its battery is no longer low, though it says nothing else of a battery", () => {
    const recovered = device("shed", "Shed door", {
      battery: null,
      batteryLow: false,
      firmware: null,
    });
    const mains = lamp("Desk lamp", {});
    expect(
      batteryOrder([mains, recovered, kitchen], now).map((each) => each.name),
    ).toEqual(["Kitchen button", "Shed door"]);
    expect(dueBatteries([recovered], now)).toEqual([]);
  });

  it("make a tile without a charge where the device says its battery is low", () => {
    expect(batteriesTile([kitchen, flagged], now)).toEqual({
      title: "Porch door",
      value: "Battery low",
      label: "Porch door's battery is low. Opens Maintenance",
    });
    expect(batteriesTile([unfigured, low], now)).toEqual({
      title: "Batteries",
      value: "Replace 2",
      label:
        "Batteries, replace 2: Hall sensor's battery is at 8%, Shed door's battery is low. Opens Maintenance",
    });
  });

  it("make a tile: one device by its name, several by their number", () => {
    expect(batteriesTile([kitchen], now)).toBeNull();
    expect(batteriesTile([kitchen, low], now)).toEqual({
      title: "Hall sensor",
      value: "Battery 8%",
      label: "Hall sensor's battery is low, 8%. Opens Maintenance",
    });
    expect(batteriesTile([quiet], now)).toEqual({
      title: "Office button",
      value: "Gone quiet",
      label:
        "Office button hasn't been heard from since Tuesday. Its battery may be empty. Opens Maintenance",
    });
    expect(batteriesTile([low, quiet, kitchen], now)).toEqual({
      title: "Batteries",
      value: "Replace 2",
      label:
        "Batteries, replace 2: Office button hasn't been heard from since Tuesday, Hall sensor's battery is at 8%. Opens Maintenance",
    });
  });
});

describe("updates", () => {
  const failed = lamp("Hall light", { state: "failed" });
  const updating = lamp("Desk lamp", { state: "updating", progress: 34.6 });
  const available = lamp("Office light", { state: "available" });
  const asleep = lamp("Office dimmer", { state: "waiting", sleeps: true });

  it("come failed first, then under way, waiting and to start", () => {
    expect(
      updatesOf([available, lamp("Porch", {}), asleep, updating, failed]).map(
        (each) => each.name,
      ),
    ).toEqual(["Hall light", "Desk lamp", "Office dimmer", "Office light"]);
  });

  it("join batteries and updates in Settings' row for Maintenance", () => {
    expect(maintenanceHint([low, quiet, updating, available], now)).toBe(
      "2 batteries · 2 updates",
    );
    expect(maintenanceHint([low], now)).toBe("1 battery");
    expect(maintenanceHint([kitchen], now)).toBeUndefined();
  });
});
