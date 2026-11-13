import { describe, expect, it } from "vitest";

import {
  createHolds,
  holdRepeatMs,
  isHold,
  isReleaseLike,
  pressActions,
  pressOf,
  tapReleaseMs,
  tapsAtRelease,
} from "../src/presses.js";
import { actionExpose } from "./pretend-bridge.js";

// A remote's presses, and the release that ends a hold.

describe("release-like actions", () => {
  it("end a press or a hold, by a word of their own", () => {
    for (const action of [
      "release",
      "released",
      "button_1_released",
      "on_press_release",
      "up_hold_release",
      "brightness_stop",
      "hold-end",
      "Release",
    ]) {
      expect(isReleaseLike(action), action).toBe(true);
    }
  });

  it("are not presses that only contain such a word", () => {
    for (const action of [
      "single",
      "hold",
      "on_press",
      "brightness_move_up",
      "arrow_left_click",
      "rotate_stopped",
      "weekend",
    ]) {
      expect(isReleaseLike(action), action).toBe(false);
    }
  });
});

describe("a remote's presses", () => {
  it("are the actions its expose declares, each once and in order", () => {
    expect(
      pressActions(actionExpose(["single", "hold", "single", "release"])),
    ).toEqual(["single", "hold"]);
    expect(pressActions(actionExpose([]))).toEqual([]);
    expect(pressActions({ type: "enum", property: "action" })).toEqual([]);
  });

  it("come in a message's action, when it is one the button declares", () => {
    const button = { property: "action", features: { actions: ["single"] } };

    expect(pressOf(button, { action: "single", battery: 100 })).toBe("single");
    // A hold's release is no press, and this one is not declared either.
    expect(pressOf(button, { action: "release" })).toBeNull();
    expect(pressOf(button, { action: "double" })).toBeNull();
    // A battery report without a press.
    expect(pressOf(button, { battery: 99 })).toBeNull();
    expect(pressOf(button, { action: "" })).toBeNull();
  });
});

describe("a remote's holds", () => {
  it("are the presses that last until their release", () => {
    for (const action of [
      "hold",
      "long",
      "up_hold",
      "button_1_hold",
      "brightness_move_up",
      "brightness_move_down",
    ]) {
      expect(isHold(action), action).toBe(true);
    }
    for (const action of [
      "single",
      "up_press",
      "up_hold_release",
      "holder",
      "brightness_move_to_level",
      "brightness_stop",
    ]) {
      expect(isHold(action), action).toBe(false);
    }
  });

  // Hue's dimmer switch gen 1 (RWL021), as Zigbee2MQTT 2.14 publishes a hold
  // of its up button: up_press first, up_hold about every 0.8 s, then
  // up_hold_release.
  const button = {
    id: "button",
    property: "action",
    features: {
      actions: ["up_press", "up_hold", "down_hold"],
      holds: ["up_hold", "down_hold"],
    },
  };

  it("reach the core once however often the remote repeats them, then their release", () => {
    let now = 0;
    const holds = createHolds(() => now);
    const heard = (action: string, at: number) => {
      now = at;
      return holds.heard("dimmer", button, { action });
    };

    expect(heard("up_press", 0)).toEqual({ press: "up_press" });
    expect(heard("up_hold", 800)).toEqual({ press: "up_hold" });
    expect(heard("up_hold", 1_600)).toBeNull();
    expect(heard("up_hold", 2_400)).toBeNull();
    expect(heard("up_hold_release", 2_900)).toEqual({ release: true });
    expect(heard("up_hold", 5_000)).toEqual({ press: "up_hold" });
    // Another hold, or the same one again after its repeats paused, as when
    // its release was lost, is a new hold.
    expect(heard("down_hold", 5_800)).toEqual({ press: "down_hold" });
    expect(heard("down_hold", 5_800 + holdRepeatMs + 1)).toEqual({
      press: "down_hold",
    });
    // A battery report says nothing of the button.
    expect(holds.heard("dimmer", button, { battery: 90 })).toBeNull();
  });

  // The whole dimmer, as Zigbee2MQTT 2.14 lists it: each button says its
  // press as it goes down, then the press's release for a tap, or holds.
  const dimmerValues = ["on", "up", "down", "off"].flatMap((name) => [
    `${name}_press`,
    `${name}_press_release`,
    `${name}_hold`,
    `${name}_hold_release`,
  ]);
  const dimmer = {
    ...button,
    features: {
      actions: pressActions(actionExpose(dimmerValues)),
      holds: pressActions(actionExpose(dimmerValues)).filter(isHold),
    },
    tapsAtRelease: tapsAtRelease(actionExpose(dimmerValues)),
  };

  it("start without a tap on a remote that says a tap again at its release", () => {
    expect(dimmer.tapsAtRelease).toEqual([
      "on_press",
      "up_press",
      "down_press",
      "off_press",
    ]);
    // Aqara's button says a press once it is over, and a remote with no
    // hold has no hold to tell a tap from.
    expect(
      tapsAtRelease(actionExpose(["single", "double", "hold", "release"])),
    ).toEqual([]);
    expect(
      tapsAtRelease(actionExpose(["button_1_press", "button_1_press_release"])),
    ).toEqual([]);

    let now = 0;
    const holds = createHolds(() => now);
    const heard = (action: string | null, at: number) => {
      now = at;
      return holds.heard("dimmer", dimmer, action ? { action } : {});
    };
    // A tap goes at its release, with the battery report between.
    expect(heard("up_press", 0)).toBeNull();
    expect(heard(null, 6)).toBeNull();
    expect(heard("up_press_release", 90)).toEqual({ press: "up_press" });
    // A hold is only the hold.
    expect(heard("up_press", 1_000)).toBeNull();
    expect(heard("up_hold", 1_800)).toEqual({ press: "up_hold" });
    expect(heard("up_hold", 2_600)).toBeNull();
    expect(heard("up_hold_release", 2_700)).toEqual({ release: true });
    // A tap whose release was lost is dropped for the next press, and one
    // whose release comes too late is no tap.
    expect(heard("on_press", 4_000)).toBeNull();
    expect(heard("off_press", 6_000)).toBeNull();
    expect(heard("off_press_release", 6_100)).toEqual({ press: "off_press" });
    expect(heard("down_press", 8_000)).toBeNull();
    expect(heard("down_press_release", 8_000 + tapReleaseMs + 1)).toEqual({
      release: true,
    });
  });

  it("are followed for each device on its own, until it is forgotten", () => {
    const holds = createHolds(() => 0);
    expect(holds.heard("a", button, { action: "up_hold" })).not.toBeNull();
    expect(holds.heard("b", button, { action: "up_hold" })).not.toBeNull();
    expect(holds.heard("a", button, { action: "up_hold" })).toBeNull();
    holds.forget("a");
    expect(holds.heard("a", button, { action: "up_hold" })).not.toBeNull();
  });
});
