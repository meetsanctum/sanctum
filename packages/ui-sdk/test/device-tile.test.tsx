// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceTile } from "../src/device-tile";
import type { Tile } from "../src/tiles";

// Tapping a tile and dragging across it.

const lamp: Tile = {
  key: "lamp/light",
  deviceId: "lamp",
  capabilityId: "light",
  kind: "light",
  roomId: null,
  name: "Lamp",
  status: "40%",
  on: true,
  look: "lit",
  colour: "#ffcfa3",
  dims: true,
  brightness: 40,
  disabled: false,
};

// React follows an input's value through the setter it patches.
const setValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

let root: Root;
let container: HTMLDivElement;
const onToggle = vi.fn();
const onDim = vi.fn();

async function render(tile: Tile) {
  await act(async () => {
    root.render(<DeviceTile tile={tile} onToggle={onToggle} onDim={onDim} />);
  });
  const button = container.querySelector("button")!;
  // jsdom lays nothing out: the tile is a row three cells wide.
  Object.defineProperty(button, "offsetWidth", { value: 200 });
  return button;
}

function pointer(
  target: Element,
  type: string,
  x: number,
  y = 0,
  pointerId = 1,
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  }) as PointerEvent;
  Object.defineProperty(event, "pointerId", { value: pointerId });
  // The first finger down is the primary one.
  Object.defineProperty(event, "isPrimary", { value: pointerId === 1 });
  target.dispatchEvent(event);
  return event;
}

async function drag(button: Element, points: [number, number][]) {
  await act(async () => {
    pointer(button, "pointerdown", 100, 0);
    for (const [x, y] of points) pointer(button, "pointermove", x, y);
    pointer(button, "pointerup", points.at(-1)![0], points.at(-1)![1]);
    // A press and release on the same element is a click, drag or not.
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  onToggle.mockReset();
  onDim.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a light's tile", () => {
  it("switches on a tap", async () => {
    const button = await render(lamp);
    await act(async () => {
      button.click();
    });
    expect(onToggle).toHaveBeenCalledWith(lamp);
    expect(onDim).not.toHaveBeenCalled();
  });

  it("dims from where it is as a finger drags across it, once it lifts, without switching", async () => {
    const button = await render(lamp);
    // Half the tile's width is 50%: from 40% to 90%, then back to 15%.
    await act(async () => {
      pointer(button, "pointerdown", 100);
      for (const x of [120, 200, 50]) pointer(button, "pointermove", x);
    });
    expect(button.textContent).toContain("15%");
    expect(onDim).not.toHaveBeenCalled();
    await act(async () => {
      pointer(button, "pointerup", 50);
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 1 }),
      );
    });
    // Only the level it ends at goes out, so a drag that ends in off comes
    // back at the level from before it, not one it passed through.
    expect(onDim.mock.calls.map(([, level]) => level)).toEqual([15]);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("dims to where the finger lifts, past the last move reported", async () => {
    const button = await render(lamp);
    await act(async () => {
      pointer(button, "pointerdown", 100);
      pointer(button, "pointermove", 120);
      pointer(button, "pointerup", 150);
    });
    expect(onDim.mock.calls).toEqual([[lamp, 65]]);
    expect(button.textContent).toContain("65%");
  });

  it("ends a drag when the tile loses the pointer, wherever it is released", async () => {
    const button = await render(lamp);
    await act(async () => {
      pointer(button, "pointerdown", 100);
      pointer(button, "pointermove", 20);
      pointer(button, "lostpointercapture", 20);
    });
    expect(onDim).toHaveBeenCalledWith(lamp, 0);
  });

  it("abandons a drag when the browser cancels it for scrolling", async () => {
    const button = await render(lamp);
    await act(async () => {
      pointer(button, "pointerdown", 100);
      pointer(button, "pointermove", 120);
    });
    expect(button.textContent).toContain("50%");
    await act(async () => {
      pointer(button, "pointercancel", 120);
      // Cancellation also releases capture; that must not send a command.
      pointer(button, "lostpointercapture", 120);
      vi.runAllTimers();
    });
    expect(onDim).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
    expect(button.textContent).toBe("Lamp40%");
    expect(button.hasAttribute("data-dragging")).toBe(false);

    await drag(button, [[140, 0]]);
    expect(onDim).toHaveBeenCalledWith(lamp, 60);
  });

  it("sends nothing for a drag that ends where it started", async () => {
    const button = await render(lamp);
    await drag(button, [
      [180, 0],
      [100, 0],
    ]);
    expect(onDim).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("turns off when dragged to nothing, and on from nothing when off", async () => {
    let button = await render(lamp);
    await drag(button, [[-200, 0]]);
    expect(onDim).toHaveBeenLastCalledWith(lamp, 0);
    expect(button.getAttribute("aria-pressed")).toBe("false");

    const off = { ...lamp, on: false, look: "off" as const, status: "Off" };
    button = await render(off);
    await act(async () => {
      vi.runAllTimers();
    });
    await drag(button, [[160, 0]]);
    expect(onDim).toHaveBeenLastCalledWith(off, 30);
  });

  it("keeps a slider's steps 300 ms apart and sends the last when it loses focus", async () => {
    await render(lamp);
    const slider = container.querySelector<HTMLInputElement>(
      'input[type="range"]',
    )!;
    const step = (value: number) => {
      setValue.call(slider, String(value));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      step(41);
      vi.advanceTimersByTime(299);
      step(42);
    });
    expect(onDim.mock.calls.map(([, level]) => level)).toEqual([41]);
    await act(async () => {
      vi.advanceTimersByTime(1);
      step(43);
      slider.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(onDim.mock.calls.map(([, level]) => level)).toEqual([41, 42, 43]);
  });

  it("does not dim on hover after a press leaves the tile before dragging", async () => {
    const button = await render(lamp);
    await act(async () => {
      pointer(button, "pointerdown", 199);
      pointer(button, "pointerout", 201);
      pointer(document.body, "pointerup", 201);
      pointer(button, "pointermove", 100);
    });
    expect(onDim).not.toHaveBeenCalled();
  });

  it("leaves a mostly vertical move to scrolling, without switching", async () => {
    const button = await render(lamp);
    await drag(button, [
      [112, 40],
      [180, 40],
    ]);
    expect(onDim).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("switches on a key after a drag", async () => {
    const button = await render(lamp);
    await drag(button, [[112, 40]]);
    await act(async () => {
      pointer(button, "pointerdown", 100);
      pointer(button, "pointermove", 160);
      pointer(button, "lostpointercapture", 160);
    });
    // Enter or Space clicks without a pointer.
    await act(async () => button.click());
    expect(onToggle).toHaveBeenCalledWith(lamp);
  });

  it("shows the light's own level again once the core answers", async () => {
    const button = await render(lamp);
    await drag(button, [[160, 0]]);
    expect(button.textContent).toContain("70%");
    await render({ ...lamp, brightness: 68, status: "68%" });
    expect(button.textContent).toContain("68%");
  });

  it("is a slider for keyboards and screen readers", async () => {
    await render(lamp);
    const slider = container.querySelector<HTMLInputElement>(
      'input[type="range"]',
    )!;
    expect(slider.getAttribute("aria-label")).toBe("Lamp brightness");
    await act(async () => {
      setValue.call(slider, "41");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onDim).toHaveBeenCalledWith(lamp, 41);
  });

  it("keeps a drag tied to the finger that started it", async () => {
    const button = await render(lamp);
    await act(async () => {
      pointer(button, "pointerdown", 100);
      pointer(button, "pointermove", 140);
      pointer(button, "pointerdown", 160, 0, 2);
      pointer(button, "pointermove", 200, 0, 2);
      pointer(button, "pointerup", 200, 0, 2);
    });
    expect(onDim).not.toHaveBeenCalled();
    expect(button.textContent).toContain("60%");
    await act(async () => pointer(button, "pointerup", 160));
    expect(onDim.mock.calls).toEqual([[lamp, 70]]);
  });

  it("starts afresh on the next press after a release it never heard", async () => {
    const button = await render(lamp);
    await act(async () => {
      pointer(button, "pointerdown", 100);
      pointer(button, "pointermove", 140);
    });
    await act(async () => {
      pointer(button, "pointerdown", 60);
      pointer(button, "pointermove", 80);
      pointer(button, "pointerup", 80);
    });
    expect(onDim.mock.calls).toEqual([[lamp, 50]]);
  });

  it("abandons a drag when the light goes offline", async () => {
    const button = await render(lamp);
    await act(async () => {
      pointer(button, "pointerdown", 100);
      pointer(button, "pointermove", 160);
    });
    await render({ ...lamp, disabled: true, dims: false, status: "Offline" });
    expect(button.textContent).toContain("Offline");
    await act(async () => pointer(button, "lostpointercapture", 160));
    expect(onDim).not.toHaveBeenCalled();
    expect(button.hasAttribute("data-dragging")).toBe(false);
  });

  it("cancels queued keyboard dimming when the light goes offline", async () => {
    await render(lamp);
    const slider = container.querySelector("input")!;
    await act(async () => {
      for (const value of [41, 42]) {
        setValue.call(slider, String(value));
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await render({ ...lamp, disabled: true, dims: false, status: "Offline" });
    await act(async () => vi.advanceTimersByTime(300));
    expect(onDim.mock.calls).toEqual([[lamp, 41]]);
  });

  it("can request the same level again after an external change", async () => {
    await render(lamp);
    const slider = container.querySelector("input")!;
    const step = () => {
      setValue.call(slider, "41");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => step());
    await render({ ...lamp, brightness: 41, status: "41%" });
    await render({ ...lamp, brightness: 40, status: "40%" });
    await act(async () => {
      vi.advanceTimersByTime(300);
      step();
    });
    expect(onDim).toHaveBeenCalledTimes(2);
    expect(onDim).toHaveBeenLastCalledWith(expect.anything(), 41);
  });

  it("cannot be dimmed or switched while offline", async () => {
    const button = await render({
      ...lamp,
      on: false,
      look: "off",
      status: "Offline",
      disabled: true,
    });
    await drag(button, [[180, 0]]);
    expect(button.disabled).toBe(true);
    expect(container.querySelector('input[type="range"]')).toBeNull();
    expect(onDim).not.toHaveBeenCalled();
  });
});

describe("a tile a command failed for", () => {
  // jsdom runs no animations: each one asked for is recorded.
  const animate = vi.fn();
  beforeEach(() => {
    animate.mockReset();
    Element.prototype.animate = animate;
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).animate;
  });
  const moved = () =>
    animate.mock.calls.map(([frames], index) => ({
      on: animate.mock.contexts[index],
      moves: Object.keys(frames[1]),
    }));

  it("turns red and shakes, without a message, then shows the light as it was", async () => {
    const button = await render(lamp);
    await drag(button, [[160, 0]]);
    expect(button.textContent).toContain("70%");
    await render({ ...lamp, failures: 1 });
    expect(button.textContent).toBe("Lamp40%");
    expect(moved()).toEqual([
      { on: expect.any(HTMLSpanElement), moves: ["opacity", "offset"] },
      { on: button, moves: ["transform"] },
    ]);
    // Each failure shows again.
    await render({ ...lamp, failures: 2 });
    expect(animate).toHaveBeenCalledTimes(4);
  });

  it("only turns red where motion is reduced", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
    }));
    await render(lamp);
    await render({ ...lamp, failures: 1 });
    expect(moved()).toEqual([
      { on: expect.any(HTMLSpanElement), moves: ["opacity", "offset"] },
    ]);
  });

  it("stays calm when it is first shown after one", async () => {
    await render({ ...lamp, failures: 3 });
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("a tile that opens its device's detail", () => {
  const onOpen = vi.fn();
  async function renderOpening(tile: Tile) {
    onOpen.mockReset();
    await act(async () => {
      root.render(
        <DeviceTile
          tile={tile}
          onToggle={onToggle}
          onDim={onDim}
          onOpen={onOpen}
        />,
      );
    });
    const [surface, icon] = container.querySelectorAll("button");
    Object.defineProperty(surface, "offsetWidth", { value: 200 });
    return { surface: surface!, icon: icon! };
  }

  it("opens on a tap and switches from its icon", async () => {
    const { surface, icon } = await renderOpening(lamp);
    expect(surface.getAttribute("aria-label")).toBe("Lamp, 40%");
    expect(surface.getAttribute("aria-haspopup")).toBe("dialog");
    expect(icon.getAttribute("aria-label")).toBe("Lamp");
    expect(icon.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      surface.click();
    });
    expect(onOpen).toHaveBeenCalledWith(lamp);
    expect(onToggle).not.toHaveBeenCalled();
    await act(async () => {
      icon.click();
    });
    expect(onToggle).toHaveBeenCalledWith(lamp);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("still dims on a drag across it, from the icon too, without opening or switching", async () => {
    const { surface, icon } = await renderOpening(lamp);
    await drag(surface, [[140, 0]]);
    expect(onDim).toHaveBeenLastCalledWith(lamp, 60);
    await act(async () => {
      vi.runAllTimers();
    });
    await drag(icon, [[60, 0]]);
    expect(onDim).toHaveBeenLastCalledWith(lamp, 20);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("opens while offline, but cannot be switched", async () => {
    const offline = {
      ...lamp,
      on: false,
      look: "off" as const,
      status: "Offline",
      dims: false,
      brightness: undefined,
      disabled: true,
    };
    const { surface, icon } = await renderOpening(offline);
    expect(surface.disabled).toBe(false);
    expect(icon.disabled).toBe(true);
    await act(async () => {
      surface.click();
    });
    expect(onOpen).toHaveBeenCalledWith(offline);
  });
});

describe("a motion sensor's tile", () => {
  const motion: Tile = {
    key: "hall/occupancy",
    deviceId: "hall",
    capabilityId: "occupancy",
    kind: "occupancy",
    roomId: null,
    name: "Hall motion sensor",
    status: "Motion now",
    on: true,
    look: "on",
    dims: false,
    disabled: false,
    motion: { occupied: true, changedAt: "2026-10-31T12:00:00.000Z" },
  };

  it("is White while it sees motion and opens its detail from anywhere, switching nothing", async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(
        <DeviceTile
          tile={motion}
          onToggle={onToggle}
          onDim={onDim}
          onOpen={onOpen}
        />,
      );
    });
    const buttons = container.querySelectorAll("button");
    // One button: its icon switches nothing.
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.dataset.look).toBe("on");
    expect(buttons[0]!.getAttribute("aria-label")).toBe(
      "Hall motion sensor, Motion now",
    );
    expect(buttons[0]!.hasAttribute("aria-pressed")).toBe(false);
    expect(container.querySelector("input")).toBeNull();
    await act(async () => {
      buttons[0]!.click();
    });
    expect(onOpen).toHaveBeenCalledWith(motion);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("is shown but not pressed where nothing opens a detail", async () => {
    const button = await render({
      ...motion,
      status: "No motion for 12 min",
      on: false,
      look: "off",
    });
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Hall motion sensorNo motion for 12 min");
  });
});

describe("a sensor's tile", () => {
  const sensor: Tile = {
    key: "office/illuminance",
    deviceId: "office",
    capabilityId: "illuminance",
    kind: "sensor",
    roomId: null,
    name: "Office motion sensor",
    status: "7 lx",
    on: false,
    look: "off",
    dims: false,
    disabled: false,
    readings: { illuminance: 7 },
    measures: ["illuminance"],
  };

  it("has the light level's sun when it reads only the light level, and a thermometer otherwise", async () => {
    const lightOnly = await render(sensor);
    expect(lightOnly.querySelector("svg.lucide-sun")).not.toBeNull();
    const climate = await render({
      ...sensor,
      status: "21.0° · 7 lx",
      readings: { temperature: 21, illuminance: 7 },
      measures: ["illuminance", "temperature"],
    });
    expect(climate.querySelector("svg.lucide-thermometer")).not.toBeNull();
  });
});

describe("an unknown device's tile", () => {
  const purifier: Tile = {
    key: "purifier/",
    deviceId: "purifier",
    capabilityId: "",
    kind: "unknown",
    roomId: null,
    name: "Unknown device",
    status: "STARKVIND air purifier",
    on: false,
    look: "off",
    dims: false,
    disabled: false,
  };

  it("has the general icon and what its driver calls it, and switches nothing", async () => {
    const button = await render(purifier);
    expect(button.querySelector("svg.lucide-radio")).not.toBeNull();
    expect(button.textContent).toBe("Unknown deviceSTARKVIND air purifier");
    // Nothing to press where the tile opens nothing.
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("opens its device where the tile opens one, with no switch of its own", async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(
        <DeviceTile
          tile={purifier}
          onToggle={onToggle}
          onDim={onDim}
          onOpen={onOpen}
        />,
      );
    });
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("aria-label")).toBe(
      "Unknown device, STARKVIND air purifier",
    );
    await act(async () => {
      buttons[0]!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 1 }),
      );
    });
    expect(onOpen).toHaveBeenCalledWith(purifier);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
