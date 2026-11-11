import { describe, expect, it, vi } from "vitest";

import { createWindowLights, trafficLights } from "../src/window-lights.js";

// A window's buttons, and a clock the test moves.
function setUp() {
  let now = 0;
  let step: (() => void) | undefined;
  const window = {
    setWindowButtonPosition: vi.fn(),
    setWindowButtonVisibility: vi.fn(),
  };
  const lights = createWindowLights(window, {
    now: () => now,
    every: (each) => {
      step = each;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    stop: () => {
      step = undefined;
    },
  });
  const advance = (ms: number) => {
    now += ms;
    step?.();
  };
  const at = () =>
    window.setWindowButtonPosition.mock.calls.at(-1)![0] as {
      x: number;
      y: number;
    };
  return { window, lights, advance, at, isSliding: () => step !== undefined };
}

describe("the traffic lights", () => {
  it("slide out with the sidebar, then hide", () => {
    const { window, lights, advance, at, isSliding } = setUp();
    lights.set(false, 248);
    expect(window.setWindowButtonVisibility).not.toHaveBeenCalled();
    advance(60);
    // Most of the way already, on the sidebar's curve.
    expect(at().x).toBeLessThan(trafficLights.x - 124);
    expect(at().x).toBeGreaterThan(trafficLights.x - 248);
    advance(240);
    expect(window.setWindowButtonVisibility).toHaveBeenLastCalledWith(false);
    expect(isSliding()).toBe(false);
  });

  it("show at once off the window's edge and slide in with it, ending in their place", () => {
    const { window, lights, advance, at } = setUp();
    lights.set(false, 0);
    window.setWindowButtonPosition.mockClear();
    lights.set(true, 264);
    expect(window.setWindowButtonVisibility).toHaveBeenLastCalledWith(true);
    expect(at()).toEqual({ x: trafficLights.x - 264, y: trafficLights.y });
    advance(150);
    expect(at().x).toBeGreaterThan(trafficLights.x - 132);
    advance(150);
    expect(at()).toEqual(trafficLights);
  });

  it("turn back from where they are when the sidebar does", () => {
    const { lights, advance, at } = setUp();
    lights.set(false, 248);
    advance(100);
    const halfway = at().x;
    lights.set(true, 248);
    advance(16);
    expect(at().x).toBeGreaterThan(halfway);
    advance(300);
    expect(at()).toEqual(trafficLights);
  });

  it("move at once where nothing slides", () => {
    const { window, lights, at, isSliding } = setUp();
    lights.set(false, 0);
    expect(window.setWindowButtonVisibility).toHaveBeenLastCalledWith(false);
    lights.set(true, 0);
    expect(window.setWindowButtonVisibility).toHaveBeenLastCalledWith(true);
    expect(at()).toEqual(trafficLights);
    expect(isSliding()).toBe(false);
  });
});
