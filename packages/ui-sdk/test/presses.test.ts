import type { LivePress, PressCapture } from "@meetsanctum/app-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveFeed, type CoreBridge } from "../src/client";
import {
  buttonLabel,
  capturePresses,
  pressGroups,
  pressLabel,
  pressTitle,
} from "../src/presses";

// A remote's presses on screen, from v1's formatButtonAction
// (button-actions.test.ts) and useButtonActionCapture.

describe("what a press is called", () => {
  it("treats inherited object names as ordinary action names", () => {
    expect(pressLabel("constructor")).toBe("Constructor");
    expect(pressLabel("button_1_constructor")).toBe("1 constructor");
    expect(pressLabel("toString")).toBe("Tostring");
  });
  it("names the common actions, in sentence case", () => {
    // v1's cases, which it wrote in title case.
    expect(pressLabel("button_1_single")).toBe("1 single press");
    expect(pressLabel("click")).toBe("Single press");
    expect(pressLabel("double")).toBe("Double press");
    expect(pressLabel("brightness_step_up")).toBe("Brightness step up");
    // The office's remotes.
    expect(pressLabel("single")).toBe("Single press");
    expect(pressLabel("quadruple")).toBe("Quadruple press");
    expect(pressLabel("hold")).toBe("Hold");
    expect(pressLabel("on_press")).toBe("On press");
    expect(pressLabel("up_hold")).toBe("Up hold");
    expect(pressLabel("1_double")).toBe("1 double press");
    expect(pressLabel("arrow-left-click")).toBe("Arrow left click");
  });
});

describe("a remote's presses by button", () => {
  it("group a Hue dimmer's presses under its four buttons", () => {
    const actions = ["on", "up", "down", "off"].flatMap((button) => [
      `${button}_press`,
      `${button}_hold`,
    ]);
    const groups = pressGroups(actions);

    expect(
      groups.map((group) => [
        group.button,
        group.presses.map((press) => press.label),
      ]),
    ).toEqual([
      ["On button", ["Press", "Hold"]],
      ["Up button", ["Press", "Hold"]],
      ["Down button", ["Press", "Hold"]],
      ["Off button", ["Press", "Hold"]],
    ]);
    expect(pressTitle("up_hold", groups)).toBe("Up button, hold");
  });

  it("keep a remote with one button, or none named, as one group", () => {
    const groups = pressGroups(["single", "double", "hold"]);
    expect(groups).toEqual([
      {
        button: null,
        presses: [
          { action: "single", label: "Single press" },
          { action: "double", label: "Double press" },
          { action: "hold", label: "Hold" },
        ],
      },
    ]);
    expect(pressTitle("double", groups)).toBe("Double press");
    expect(pressGroups(["button_1_single", "button_1_double"])).toHaveLength(1);
    expect(pressGroups(["on", "off", "brightness_move_up"])).toHaveLength(1);
  });

  it("name numbered and many-word buttons", () => {
    expect(buttonLabel("button_2")).toBe("Button 2");
    expect(buttonLabel("1")).toBe("Button 1");
    expect(buttonLabel("arrow_left")).toBe("Arrow left button");
    expect(
      pressGroups(["button_1_single", "button_2_double"]).map(
        (group) => group.button,
      ),
    ).toEqual(["Button 1", "Button 2"]);
  });
});

describe("capturing a remote's presses", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function bridgeWith(start: () => Promise<PressCapture>) {
    const live = createLiveFeed();
    const json = vi.fn(async (path: string, _init?: unknown) =>
      path === "/api/devices/capture/start" ? start() : undefined,
    );
    const bridge = { json: json as CoreBridge["json"], live };
    return { bridge, json, live };
  }

  const press = (device: string, action = "single"): LivePress => ({
    type: "press",
    device,
    capability: "button",
    action,
    isCaptured: true,
    at: "2026-10-29T10:00:00.000Z",
  });

  const inFiveMinutes = () => new Date(Date.now() + 5 * 60_000).toISOString();

  it.each([-60 * 60_000, 60 * 60_000])(
    "expires after five minutes when the core's clock differs by %s ms",
    async (offset) => {
      vi.useFakeTimers();
      const serverNow = Date.now() + offset;
      const { bridge, live } = bridgeWith(async () => ({
        id: "capture-1",
        device: "remote",
        until: new Date(serverNow + 5 * 60_000).toISOString(),
      }));
      const pressed = vi.fn();
      const ended = vi.fn();
      capturePresses(bridge, "remote", { press: pressed, ended });
      await vi.advanceTimersByTimeAsync(1);
      live.publish({
        ...press("remote"),
        at: new Date(serverNow + 1).toISOString(),
      });
      expect(pressed).toHaveBeenCalledTimes(1);
      expect(ended).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(ended).toHaveBeenCalledExactlyOnceWith("expired");
    },
  );

  it("ignores a press sent before capture even if it arrives after the start response", async () => {
    const { bridge, live } = bridgeWith(async () => ({
      id: "capture-1",
      device: "remote",
      until: inFiveMinutes(),
    }));
    const pressed = vi.fn();
    const capture = capturePresses(bridge, "remote", { press: pressed });
    await new Promise((resolve) => setTimeout(resolve, 0));
    live.publish({ ...press("remote"), isCaptured: false });
    live.publish(press("remote"));
    expect(pressed).toHaveBeenCalledExactlyOnceWith(press("remote"));
    await capture.stop();
  });

  it("ends once a press reaches workflows after it began, as after a core restart, but not on a refresh", async () => {
    const { bridge, live, json } = bridgeWith(async () => ({
      id: "capture-1",
      device: "remote",
      until: inFiveMinutes(),
    }));
    const pressed = vi.fn();
    const ended = vi.fn();
    const capture = capturePresses(bridge, "remote", { press: pressed, ended });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The shell refreshes its live feed every so often and on focus.
    live.refresh();
    live.publish(press("remote"));
    expect(ended).not.toHaveBeenCalled();
    expect(pressed).toHaveBeenCalledOnce();

    live.publish({
      ...press("remote"),
      at: new Date().toISOString(),
      isCaptured: false,
    });
    expect(ended).toHaveBeenCalledExactlyOnceWith("failed");
    expect(json).toHaveBeenLastCalledWith("/api/devices/capture/stop", {
      method: "POST",
      json: { id: "capture-1" },
    });
    await capture.stop();
  });

  it("rejects presses after the server expiry even before the timer runs", async () => {
    const until = inFiveMinutes();
    const { bridge, live } = bridgeWith(async () => ({
      id: "capture-1",
      device: "remote",
      until,
    }));
    const pressed = vi.fn();
    const ended = vi.fn();
    const capture = capturePresses(bridge, "remote", { press: pressed, ended });
    await new Promise((resolve) => setTimeout(resolve, 0));
    live.publish({ ...press("remote"), at: until });
    expect(pressed).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledExactlyOnceWith("expired");
    await capture.stop();
  });

  it("reports a failed stop and lets the caller retry releasing it", async () => {
    const { bridge, json, live } = bridgeWith(async () => ({
      id: "capture-1",
      device: "remote",
      until: inFiveMinutes(),
    }));
    const pressed = vi.fn();
    const capture = capturePresses(bridge, "remote", { press: pressed });
    await new Promise((resolve) => setTimeout(resolve, 0));
    json.mockRejectedValueOnce(new Error("offline"));
    await expect(capture.stop()).rejects.toThrow("offline");
    live.publish(press("remote"));
    expect(pressed).not.toHaveBeenCalled();
    await capture.stop();
    expect(json).toHaveBeenCalledTimes(3);
  });

  it("hands on the remote's presses once the core holds them back, until stopped", async () => {
    const { bridge, json, live } = bridgeWith(async () => ({
      id: "capture-1",
      device: "remote",
      until: inFiveMinutes(),
    }));
    const pressed = vi.fn();

    const capture = capturePresses(bridge, "remote", { press: pressed });
    // Before the core holds them back, a press reached workflows too.
    live.publish(press("remote", "hold"));
    // Once the core has answered.
    await new Promise((resolve) => setTimeout(resolve, 0));
    live.publish(press("remote"));
    live.publish(press("another remote"));
    await capture.stop();
    live.publish(press("remote", "double"));

    expect(pressed.mock.calls).toEqual([[press("remote")]]);
    expect(json.mock.calls).toEqual([
      [
        "/api/devices/capture/start",
        { method: "POST", json: { device: "remote" } },
      ],
      [
        "/api/devices/capture/stop",
        { method: "POST", json: { id: "capture-1" } },
      ],
    ]);
  });

  it("says when it ended by itself", async () => {
    vi.useFakeTimers();
    const { bridge } = bridgeWith(async () => ({
      id: "capture-1",
      device: "remote",
      until: inFiveMinutes(),
    }));
    const ended = vi.fn();

    capturePresses(bridge, "remote", { press: vi.fn(), ended });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(ended).toHaveBeenCalledWith("expired");
  });

  it("says when it could not start", async () => {
    const { bridge } = bridgeWith(async () => {
      throw new Error("forbidden");
    });
    const ended = vi.fn();

    capturePresses(bridge, "remote", { press: vi.fn(), ended });

    await vi.waitFor(() => expect(ended).toHaveBeenCalledWith("failed"));
  });

  it("ends one the core started after it was stopped", async () => {
    let started!: (capture: PressCapture) => void;
    const { bridge, json } = bridgeWith(
      () => new Promise((resolve) => (started = resolve)),
    );

    const capture = capturePresses(bridge, "remote", { press: vi.fn() });
    await capture.stop();
    started({ id: "late", device: "remote", until: inFiveMinutes() });

    await vi.waitFor(() =>
      expect(json).toHaveBeenLastCalledWith("/api/devices/capture/stop", {
        method: "POST",
        json: { id: "late" },
      }),
    );
  });

  it.each(["captured", "uncaptured", "earlier", "stopped"])(
    "handles a %s press that arrives before the start response",
    async (kind) => {
      let started!: (capture: PressCapture) => void;
      const { bridge, live } = bridgeWith(
        () => new Promise((resolve) => (started = resolve)),
      );
      const pressed = vi.fn();
      const capture = capturePresses(bridge, "remote", { press: pressed });
      const now = Date.now();
      const event = {
        ...press("remote"),
        at: new Date(now - (kind === "earlier" ? 1 : 0)).toISOString(),
        isCaptured: kind !== "uncaptured",
      };
      live.publish(event);
      expect(pressed).not.toHaveBeenCalled();
      if (kind === "stopped") await capture.stop();
      started({
        id: "pending",
        device: "remote",
        until: new Date(now + 5 * 60_000).toISOString(),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (kind === "captured") {
        expect(pressed).toHaveBeenCalledExactlyOnceWith(event);
      } else {
        expect(pressed).not.toHaveBeenCalled();
      }
      await capture.stop();
    },
  );

  it("releases a late start after stopping, reporting its cleanup failure", async () => {
    let started!: (capture: PressCapture) => void;
    const { bridge, json, live } = bridgeWith(
      () => new Promise((resolve) => (started = resolve)),
    );
    const pressed = vi.fn();
    const ended = vi.fn(() => void capture.stop());
    const capture = capturePresses(bridge, "remote", {
      press: pressed,
      ended,
    });
    await capture.stop();
    json.mockRejectedValueOnce(new Error("offline"));
    started({ id: "late", device: "remote", until: inFiveMinutes() });
    await vi.waitFor(() => expect(json).toHaveBeenCalledTimes(3));
    live.publish(press("remote"));
    expect(pressed).not.toHaveBeenCalled();
    // The failed release says so, and the retry its listener makes then
    // releases the capture it now knows the id of.
    expect(ended).toHaveBeenCalledExactlyOnceWith("failed");
    expect(json).toHaveBeenCalledTimes(3);
  });
});
