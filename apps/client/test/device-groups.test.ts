import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  deviceGroupOf,
  deviceGroups,
  deviceGroupTitle,
  groupCounts,
  groupNoun,
} from "../src/device-groups";
import { settingsPageTitle } from "../src/system-apps";
import { light } from "./settings-devices-fixtures";

// Settings → Devices lists the home's devices by category, each device in
// the one category of its type.

const device = (id: string, type: DeviceInfo["type"]) =>
  light(id, id, { type }) as DeviceInfo;

describe("Settings → Devices' groups", () => {
  it("put each device in the category of its type, once", () => {
    expect(deviceGroupOf(device("a", "light"))).toBe("lights");
    expect(deviceGroupOf(device("b", "plug"))).toBe("switches");
    // A motion sensor that measures too is under Presence alone.
    expect(deviceGroupOf(device("c", "motion"))).toBe("presence");
    expect(deviceGroupOf(device("d", "window"))).toBe("security");
    expect(deviceGroupOf(device("e", "smart-speaker"))).toBe("media");
    expect(deviceGroupOf(device("f", "unknown"))).toBe("unknown");
  });

  it("come in the sidebar's order, Unknown Devices last, leaving out empty ones", () => {
    const groups = deviceGroups([
      device("x", "unknown"),
      device("remote", "button"),
      device("desk", "light"),
      device("door", "contact"),
      device("lamp", "light"),
    ]);
    expect(groups.map((group) => group.title)).toEqual([
      "Lights",
      "Security",
      "Buttons",
      "Unknown Devices",
    ]);
    // In the order given, which the page sorts by name.
    expect(groups[0]!.devices.map((each) => each.id)).toEqual(["desk", "lamp"]);
    expect(deviceGroups([])).toEqual([]);
  });

  it("count what needs attention, then other updates, then the devices", () => {
    const updatable = (id: string) =>
      ({
        ...light(id, id),
        firmware: { state: "available" },
      }) as DeviceInfo;
    const devices = [updatable("a"), updatable("b"), device("c", "light")];
    expect(groupCounts(devices, () => false)).toEqual({
      attention: null,
      updates: "2 updates",
      count: "3 devices",
    });
    // A device that needs attention isn't counted again for its update.
    expect(groupCounts(devices, (each) => each.id !== "c")).toEqual({
      attention: "2 need attention",
      updates: null,
      count: "3 devices",
    });
    expect(groupCounts([updatable("a")], () => true).attention).toBe(
      "1 needs attention",
    );
    expect(groupCounts([updatable("a")], () => false)).toEqual({
      attention: null,
      updates: "1 update",
      count: "1 device",
    });
  });

  it("are named for Back and in sentences", () => {
    expect(deviceGroupTitle("presence")).toBe("Presence");
    expect(deviceGroupTitle("unknown")).toBe("Unknown Devices");
    expect(deviceGroupTitle("curtains")).toBeUndefined();
    expect(settingsPageTitle("device-group", { id: "lights" }, [])).toBe(
      "Lights",
    );
    expect(groupNoun("presence")).toBe("motion sensors");
    expect(groupNoun("constructor")).toBe("devices");
  });
});
