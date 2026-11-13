import type { DeviceInfo, FirmwareInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  batteriesTile,
  batteryOrder,
  dueBatteries,
  maintenanceHint,
  namesOf,
  sinceWords,
  updatesLine,
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
    battery: 64,
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

  it("make Settings' row: the one that leads, then a few names", () => {
    expect(updatesLine([updating, available, asleep])).toBe(
      "Desk lamp is updating, 34% · then Office light and Office dimmer",
    );
    expect(updatesLine([failed])).toBe("Hall light's update didn't finish");
    expect(updatesLine([available, lamp("Porch", {})])).toBe(
      "Office light and Porch",
    );
    expect(namesOf([available, updating, failed, asleep])).toBe(
      "Office light, Desk lamp and 2 more",
    );
  });

  it("join batteries in the section's hint", () => {
    expect(maintenanceHint([low, quiet, updating, available], now)).toBe(
      "2 batteries · 2 updates",
    );
    expect(maintenanceHint([low], now)).toBe("1 battery");
    expect(maintenanceHint([kitchen], now)).toBeUndefined();
  });
});
