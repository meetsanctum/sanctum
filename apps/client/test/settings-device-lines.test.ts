import type { DeviceInfo, JoinedDevice } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { stageText } from "../src/add-devices-cards";
import { countdown } from "../src/add-devices-joining";
import { deviceDetail, deviceStatus } from "../src/settings-devices";
import { light, now, office, remote } from "./settings-devices-fixtures";

// How Settings → Devices words a device's line and adding devices.

describe("a device's line", () => {
  it("names its room, what its driver calls it and whether it is offline", () => {
    expect(deviceDetail(light("a", "Desk lamp"), [office])).toBe(
      "No room · Hue Essential White and Color Ambiance A60",
    );
    expect(
      deviceDetail(
        light("a", "Hue Essential White and Color Ambiance A60", {
          roomId: "office",
          availability: "offline",
        }),
        [office],
      ),
    ).toBe("Office · Offline");
  });

  it("says a battery's charge, and leads with a low one unless an update has news", () => {
    expect(deviceDetail({ ...remote, battery: 64 }, [office])).toBe(
      "Office · Wireless mini switch · Battery 64%",
    );
    const low = { ...remote, battery: 8 };
    expect(deviceDetail(low, [office])).toBe("Office · Wireless mini switch");
    expect(deviceStatus(low, null, now)).toEqual({
      text: "Battery low, 8%: replace it soon",
      tone: "problem",
    });
    const updating = { text: "Updating, 40%", tone: "busy" } as const;
    expect(deviceStatus(low, updating, now)).toBe(updating);
    // The device says its battery is low: its charge stays on its line.
    const flagged = { ...remote, battery: 63, batteryLow: true };
    expect(deviceDetail(flagged, [office])).toBe(
      "Office · Wireless mini switch · Battery 63%",
    );
    expect(deviceStatus(flagged, null, now)).toEqual({
      text: "Battery low: replace it soon",
      tone: "problem",
    });
    expect(deviceStatus({ ...flagged, battery: null }, null, now)).toEqual({
      text: "Battery low: replace it soon",
      tone: "problem",
    });
    expect(deviceStatus(remote, null, now)).toBeNull();
  });

  it("leads with a remote on a battery gone quiet, as Maintenance says it", () => {
    const quiet = {
      ...remote,
      battery: 6,
      availability: "unknown",
      lastSeenAt: "2026-10-27T09:10:00Z",
    } satisfies DeviceInfo;
    expect(deviceStatus(quiet, null, now)).toEqual({
      text: "Not heard from since Tuesday: try a new battery",
      tone: "problem",
    });
    // Not for a day yet: its low battery leads.
    expect(
      deviceStatus({ ...quiet, lastSeenAt: "2026-10-31T01:00:00Z" }, null, now),
    ).toEqual({ text: "Battery low, 6%: replace it soon", tone: "problem" });
  });

  it("leads with a device its network no longer has, instead of Offline", () => {
    const left = {
      ...remote,
      availability: "offline",
      battery: 8,
      leftAt: "2026-10-31T12:00:00.000Z",
      problem: null,
    } satisfies DeviceInfo;
    expect(deviceDetail(left, [office])).toBe("Office · Wireless mini switch");
    expect(
      deviceStatus(left, { text: "Update available", tone: "plain" }, now),
    ).toEqual({
      text: "Not paired any more: add it again or remove it",
      tone: "problem",
    });
  });

  it("leads with what its driver says is wrong, before its firmware's news", () => {
    const broken = {
      ...remote,
      problem: { id: "loose", words: "Its plug is loose", repair: null },
    } satisfies DeviceInfo;
    expect(
      deviceStatus(broken, { text: "Update available", tone: "plain" }, now),
    ).toEqual({ text: "Its plug is loose", tone: "problem" });
  });

  it("says a remote's press for a moment, by what it is called", () => {
    expect(deviceDetail(remote, [office], "single")).toBe(
      "Office · Wireless mini switch · Single press just now",
    );
    expect(deviceDetail(remote, [office], "up_hold")).toBe(
      "Office · Wireless mini switch · Up hold just now",
    );
  });
});

describe("adding devices' words", () => {
  const joined = (stage: JoinedDevice["stage"], known = false) =>
    ({
      driver: "sanctum.zigbee",
      key: "0x1",
      stage,
      description: null,
      deviceId: null,
      known,
      joinedAt: "2026-10-29T12:00:00Z",
    }) satisfies JoinedDevice;

  it("count down in minutes and seconds", () => {
    expect(countdown(240)).toBe("4:00");
    expect(countdown(65)).toBe("1:05");
  });

  it("say how far a device has come", () => {
    expect(stageText(joined("joined"))).toBe("Joining…");
    expect(stageText(joined("interviewing"))).toBe("Setting up…");
    expect(stageText(joined("ready"))).toBe("Ready");
    expect(stageText(joined("ready", true))).toBe("Joined again");
    expect(stageText(joined("unsupported"))).toBe(
      "Sanctum can't use this device",
    );
  });

  it("say that a device which joined has nothing Sanctum can use", () => {
    const purifier = { ...remote, type: "unknown" as const, capabilities: [] };
    expect(stageText(joined("ready"), purifier)).toBe(
      "Sanctum can't use this device",
    );
    expect(stageText(joined("ready", true), purifier)).toBe(
      "Sanctum can't use this device",
    );
    // One it can use is ready as before.
    expect(stageText(joined("ready"), remote)).toBe("Ready");
    expect(stageText(joined("interviewing"), purifier)).toBe("Setting up…");
  });
});
