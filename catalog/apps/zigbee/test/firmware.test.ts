import { describe, expect, it } from "vitest";

import {
  firmwareOf,
  isWorthSaying,
  problemOf,
  versionOf,
} from "../src/firmware.js";

// What Zigbee2MQTT says of a device's firmware (availability, progress and
// errors), onto the Drivers contract's states.

describe("a device's firmware, from its state's update", () => {
  it("says whether an update is available", () => {
    expect(
      firmwareOf({
        state: "available",
        installed_version: 16780552,
        latest_version: 16781824,
      }),
    ).toEqual({ state: "available", progress: null, remainingSeconds: null });
    expect(
      firmwareOf({
        state: "idle",
        installed_version: 16781824,
        latest_version: 16781824,
      }),
    ).toMatchObject({ state: "current" });
  });

  it("keeps an update available that Zigbee2MQTT forgot when it restarted", () => {
    expect(
      firmwareOf({
        state: "idle",
        installed_version: 16780552,
        latest_version: 16781824,
      }),
    ).toMatchObject({ state: "available" });
  });

  it("follows an update's progress and the time it has left", () => {
    expect(
      firmwareOf({ state: "updating", progress: 34.52, remaining: 3001.4 }),
    ).toEqual({ state: "updating", progress: 34.52, remainingSeconds: 3001 });
    expect(firmwareOf({ state: "updating" })).toEqual({
      state: "updating",
      progress: null,
      remainingSeconds: null,
    });
    expect(
      firmwareOf({ state: "updating", progress: 140, remaining: -3 }),
    ).toMatchObject({ progress: 100, remainingSeconds: 0 });
  });

  it("waits for a sleeping device that is scheduled to update", () => {
    expect(firmwareOf({ state: "scheduled" })).toMatchObject({
      state: "waiting",
    });
  });

  it("says nothing it does not know", () => {
    expect(firmwareOf(undefined)).toBeNull();
    expect(firmwareOf("available")).toBeNull();
    expect(firmwareOf({ state: "rebooting" })).toBeNull();
  });
});

describe("what a device runs", () => {
  it("is its software build, else its date code", () => {
    expect(
      versionOf({ software_build_id: "1.126.9", date_code: "20250226" }),
    ).toBe("1.126.9");
    expect(versionOf({ date_code: "20250226" })).toBe("20250226");
    expect(versionOf({})).toBeNull();
  });
});

describe("why an update failed", () => {
  it("is said in words for people", () => {
    expect(
      problemOf(
        "OTA update of 'Office light' failed (Device didn't respond to OTA request)",
      ),
    ).toBe("It stopped answering.");
    expect(
      problemOf("Zigbee2MQTT did not answer: device ota update update"),
    ).toBe("It stopped answering.");
    expect(
      problemOf(
        "Update of 'Office light' failed (No image currently available)",
      ),
    ).toBe("No update is available for it any more.");
    expect(problemOf("something else")).toBe("The update did not finish.");
  });
});

describe("telling the core of an update's progress", () => {
  const updating = (progress: number) => ({
    state: "updating" as const,
    progress,
    remainingSeconds: 100,
  });

  it("tells every change of state, and progress every whole percent after a while", () => {
    expect(isWorthSaying(undefined, updating(0), 0)).toBe(true);
    const last = { ...updating(1.2), at: 0 };
    expect(isWorthSaying(last, updating(1.9), 10_000)).toBe(false);
    expect(isWorthSaying(last, updating(2.1), 1_000)).toBe(false);
    expect(isWorthSaying(last, updating(2.1), 5_000)).toBe(true);
    expect(isWorthSaying(last, updating(100), 1_000)).toBe(true);
    expect(
      isWorthSaying(
        last,
        { state: "current", progress: null, remainingSeconds: null },
        1,
      ),
    ).toBe(true);
    const available = {
      state: "available" as const,
      progress: null,
      remainingSeconds: null,
    };
    expect(isWorthSaying({ ...available, at: 0 }, available, 60_000)).toBe(
      false,
    );
  });
});
