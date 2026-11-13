// @vitest-environment jsdom
import type { LightFeatures, LightState } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LightControls } from "../src/light-controls";

// A light's controls in its detail: the colour and white pickers and the
// brightness slider, on pages to swipe or choose from their tabs.

const colourLight: LightFeatures = {
  brightness: true,
  colorTemperature: { min: 153, max: 500 },
  color: true,
};
const orange: LightState = {
  on: true,
  brightness: 60,
  colorMode: "color",
  hue: 28,
  saturation: 65,
  colorTemperature: 370,
};

// React follows an input's value through the setter it patches.
const setValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

let root: Root;
let container: HTMLDivElement;
const onCommand = vi.fn();

async function render(
  features: LightFeatures,
  state: LightState,
  extra: { disabled?: boolean; failures?: number } = {},
) {
  await act(async () => {
    root.render(
      <LightControls
        name="Lamp"
        features={features}
        state={state}
        onCommand={onCommand}
        {...extra}
      />,
    );
  });
}

const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === label || each.textContent === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
};
const labels = (selector: string) =>
  [...container.querySelectorAll(selector)].map((each) =>
    each.getAttribute("aria-label"),
  );
const pressed = () =>
  [...container.querySelectorAll('button[aria-pressed="true"]')].map(
    (each) => each.getAttribute("aria-label") ?? each.textContent,
  );
const input = (label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

function pointer(
  target: Element,
  type: string,
  x: number,
  y: number,
  pointerId = 1,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  Object.defineProperty(event, "isPrimary", { value: pointerId === 1 });
  target.dispatchEvent(event);
}

// jsdom lays nothing out: a box at the origin.
function place(element: Element, width: number, height: number) {
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height }) as DOMRect;
}

async function step(element: HTMLInputElement, value: number) {
  await act(async () => {
    setValue.call(element, String(value));
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  onCommand.mockReset();
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

describe("a colour light's colour", () => {
  it("rings eight colours around the current one, nearest pressed", async () => {
    await render(colourLight, orange);
    expect(labels("[data-fly]")).toEqual([
      "Red",
      "Orange",
      "Yellow",
      "Lime",
      "Green",
      "Cyan",
      "Blue",
      "Magenta",
    ]);
    expect(pressed()).toEqual(["Orange", "Colour"]);
  });

  it("turns the light on in a colour, then offers its shades", async () => {
    await render(colourLight, { ...orange, on: false });
    await click(button("Blue"));
    expect(onCommand).toHaveBeenCalledWith({
      on: true,
      hue: 220,
      saturation: 100,
    });
    expect(labels("[data-fly]")).toEqual([
      "20% saturation",
      "35% saturation",
      "50% saturation",
      "65% saturation",
      "80% saturation",
      "100% saturation",
      "Back to colours",
      "Done with shades",
    ]);
  });

  it("sets a shade of the light's own colour, and goes back from the shades", async () => {
    await render(colourLight, orange);
    await click(button("Shades"));
    expect(pressed()).toContain("65% saturation");
    await click(button("35% saturation"));
    expect(onCommand).toHaveBeenCalledWith({
      on: true,
      hue: 28,
      saturation: 35,
    });
    await click(button("Back to colours"));
    expect(labels("[data-fly]")).toContain("Magenta");
  });

  it("sets shades of the chosen colour while the device has not answered", async () => {
    await render(colourLight, orange);
    await click(button("Blue"));
    await click(button("35% saturation"));
    expect(onCommand).toHaveBeenLastCalledWith({
      on: true,
      hue: 220,
      saturation: 35,
    });
    await click(button("Colour wheel"));
    expect(input("Lamp hue").value).toBe("220");
    expect(input("Lamp saturation").value).toBe("35");
  });

  it("drops a chosen colour when its command fails", async () => {
    await render(colourLight, orange);
    await click(button("Blue"));
    await render(colourLight, orange, { failures: 1 });
    await click(button("35% saturation"));
    expect(onCommand).toHaveBeenLastCalledWith({
      on: true,
      hue: 28,
      saturation: 35,
    });
  });

  it("sends a drag on the colour wheel once it ends", async () => {
    await render(colourLight, orange);
    await click(button("Shades"));
    await click(button("Colour wheel"));
    const wheel = input("Lamp hue").parentElement!;
    place(wheel, 200, 200);
    await act(async () => {
      pointer(wheel, "pointerdown", 100, 100);
      // Straight right of the middle, all the way out: hue 90, full colour.
      pointer(wheel, "pointermove", 190, 100);
    });
    expect(onCommand).not.toHaveBeenCalled();
    expect(input("Lamp hue").value).toBe("90");
    await act(async () => {
      // Straight down, halfway out: hue 180.
      pointer(wheel, "pointerup", 100, 144);
    });
    expect(onCommand.mock.calls).toEqual([
      [{ on: true, hue: 180, saturation: 50 }],
    ]);
  });

  it("keeps the wheel's keys 300 ms apart and sends the last when it loses focus", async () => {
    await render(colourLight, orange);
    await click(button("Shades"));
    await click(button("Colour wheel"));
    await step(input("Lamp hue"), 30);
    await step(input("Lamp hue"), 35);
    await step(input("Lamp saturation"), 70);
    expect(onCommand.mock.calls).toEqual([
      [{ on: true, hue: 30, saturation: 65 }],
    ]);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(onCommand).toHaveBeenLastCalledWith({
      on: true,
      hue: 35,
      saturation: 70,
    });
  });

  it("steps a white light's hue in full colour", async () => {
    await render(colourLight, {
      on: true,
      brightness: 60,
      colorMode: "temperature",
      colorTemperature: 370,
    });
    await click(button("Colour"));
    await click(button("Shades"));
    await click(button("Colour wheel"));
    expect(input("Lamp saturation").value).toBe("0");
    await step(input("Lamp hue"), 120);
    expect(onCommand).toHaveBeenCalledWith({
      on: true,
      hue: 120,
      saturation: 100,
    });
  });
});

describe.each(["brightness", "hue", "white"] as const)(
  "%s gestures",
  (control) => {
    async function showControl() {
      await render(colourLight, orange);
      if (control === "brightness") await click(button("Brightness"));
      else if (control === "hue") {
        await click(button("Shades"));
        await click(button("Colour wheel"));
      } else {
        await click(button("White"));
        await click(button("White wheel"));
      }
      const slider = input(`Lamp ${control}`).parentElement!;
      place(slider, 200, 200);
      return slider;
    }

    it("cancels a drag when the light goes offline, even if it reconnects before release", async () => {
      const slider = await showControl();
      await act(async () => {
        pointer(slider, "pointerdown", 100, 100);
        pointer(slider, "pointermove", 190, 100);
      });
      await render(colourLight, orange, { disabled: true });
      await render(colourLight, orange);
      await act(async () => {
        pointer(slider, "pointerup", 190, 100);
        pointer(slider, "lostpointercapture", 190, 100);
      });
      expect(onCommand).not.toHaveBeenCalled();
    });

    it("lets only the first finger control a drag", async () => {
      const slider = await showControl();
      await act(async () => {
        pointer(slider, "pointerdown", 100, 100);
        pointer(slider, "pointerdown", 150, 100, 2);
        pointer(slider, "pointerup", 150, 100, 2);
      });
      expect(onCommand).not.toHaveBeenCalled();
      await act(async () => {
        pointer(slider, "pointerup", 190, 100);
      });
      expect(onCommand).toHaveBeenCalledTimes(1);
    });

    it("does not send an older queued key value after a pointer command", async () => {
      const slider = await showControl();
      const start = control === "white" ? 3000 : 30;
      await step(input(`Lamp ${control}`), start);
      await step(
        input(`Lamp ${control}`),
        start + (control === "white" ? 100 : 5),
      );
      await act(async () => {
        pointer(slider, "pointerdown", 100, 100);
        pointer(slider, "pointerup", 190, 100);
      });
      const sent = [...onCommand.mock.calls];
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(onCommand.mock.calls).toEqual(sent);
    });

    it("discards a cancelled drag", async () => {
      const slider = await showControl();
      const initial = input(`Lamp ${control}`).value;
      await act(async () => {
        pointer(slider, "pointerdown", 100, 100);
        pointer(slider, "pointermove", 190, 100);
        pointer(slider, "pointercancel", 190, 100);
        pointer(slider, "lostpointercapture", 190, 100);
      });
      expect(onCommand).not.toHaveBeenCalled();
      expect(input(`Lamp ${control}`).value).toBe(initial);
    });
  },
);

describe("a light's white", () => {
  it("spreads eight whites across the light's own range", async () => {
    await render(
      {
        brightness: true,
        colorTemperature: { min: 250, max: 454 },
        color: false,
      },
      {
        on: true,
        brightness: 100,
        colorMode: "temperature",
        colorTemperature: 280,
      },
    );
    expect(labels("[data-fly]")).toEqual([
      "4,000 K",
      "3,600 K",
      "3,200 K",
      "3,000 K",
      "2,700 K",
      "2,500 K",
      "2,400 K",
      "2,200 K",
    ]);
    expect(pressed()).toEqual(["3,600 K", "White"]);
    await click(button("2,200 K"));
    expect(onCommand).toHaveBeenCalledWith({ on: true, colorTemperature: 454 });
  });

  it("offers white beside colour and sends a drag on its wheel once it ends", async () => {
    await render(colourLight, orange);
    await click(button("White"));
    expect(labels("[data-fly]")).toHaveLength(8);
    await click(button("White wheel"));
    const wheel = input("Lamp white").parentElement!;
    place(wheel, 100, 100);
    await act(async () => {
      pointer(wheel, "pointerdown", 50, 8);
      pointer(wheel, "pointerup", 50, 92);
    });
    // Cool at the top, warm at the bottom.
    expect(onCommand.mock.calls).toEqual([
      [{ on: true, colorTemperature: 500 }],
    ]);
  });
});

describe("a light's pages", () => {
  it("has a page for colour and one for brightness, chosen from tabs or arrow keys", async () => {
    await render(colourLight, orange);
    const tabs = () =>
      [...container.querySelectorAll('[role="tab"]')].map(
        (each) =>
          `${each.getAttribute("aria-label")}${each.getAttribute("aria-selected") === "true" ? " (current)" : ""}`,
      );
    expect(tabs()).toEqual(["Colour (current)", "Brightness"]);
    await click(button("Brightness"));
    expect(tabs()).toEqual(["Colour", "Brightness (current)"]);
    await act(async () => {
      container
        .querySelector('[role="tablist"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
        );
    });
    expect(tabs()).toEqual(["Colour (current)", "Brightness"]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Colour");
  });

  it("turns the page on a swipe, which presses nothing", async () => {
    await render(colourLight, orange);
    const pages =
      container.querySelector("[role=tabpanel]")!.parentElement!.parentElement!;
    const red = button("Red");
    await act(async () => {
      pointer(red, "pointerdown", 300, 100);
      pointer(red, "pointermove", 250, 102);
      pointer(red, "pointermove", 150, 104);
      pointer(red, "pointerup", 150, 104);
      red.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(onCommand).not.toHaveBeenCalled();
    expect(pages.querySelector("[role=tabpanel]:not([inert])")?.id).toMatch(
      /brightness$/,
    );
  });

  it("does not pick a colour after a vertical drag", async () => {
    await render(colourLight, orange);
    const red = button("Red");
    await act(async () => {
      pointer(red, "pointerdown", 100, 100);
      pointer(red, "pointermove", 102, 125);
      pointer(red, "pointerup", 102, 125);
      red.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("keeps keyboard activation working after a swipe with no click", async () => {
    await render(colourLight, orange);
    const red = button("Red");
    await act(async () => {
      pointer(red, "pointerdown", 100, 100);
      pointer(red, "pointermove", 125, 100);
      pointer(red, "pointerup", 125, 100);
    });
    await click(red);
    expect(onCommand).toHaveBeenCalledWith({
      on: true,
      hue: 0,
      saturation: 100,
    });
  });

  it("forgets a press that leaves the pages before a swipe starts", async () => {
    await render(colourLight, orange);
    const pages =
      container.querySelector("[role=tabpanel]")!.parentElement!.parentElement!;
    await act(async () => {
      pointer(pages, "pointerdown", 300, 100);
      pointer(pages, "pointerout", 305, 100);
      // The mouse released elsewhere and returned without pressing again.
      pointer(pages, "pointermove", 150, 100);
    });
    expect(container.querySelector("[data-swiping]")).toBeNull();
  });

  it("sends a drag on the brightness slider once it ends, 0 for off", async () => {
    await render(colourLight, orange);
    const slider = input("Lamp brightness").parentElement!;
    place(slider, 96, 200);
    await act(async () => {
      pointer(slider, "pointerdown", 48, 100);
      pointer(slider, "pointermove", 48, 150);
    });
    expect(input("Lamp brightness").value).toBe("25");
    expect(onCommand).not.toHaveBeenCalled();
    await act(async () => {
      pointer(slider, "pointerup", 48, 260);
    });
    expect(onCommand.mock.calls).toEqual([[{ brightness: 0 }]]);
  });

  it("can restore the reported brightness before a previous command is acknowledged", async () => {
    await render(colourLight, orange);
    await click(button("Brightness"));
    const slider = input("Lamp brightness").parentElement!;
    place(slider, 96, 200);
    await step(input("Lamp brightness"), 30);
    await step(input("Lamp brightness"), 35);
    await act(async () => {
      pointer(slider, "pointerdown", 48, 100);
      pointer(slider, "pointerup", 48, 80);
      vi.advanceTimersByTime(300);
    });
    expect(onCommand).toHaveBeenLastCalledWith({ brightness: 60 });
  });

  it("drops what a drag showed when a command fails", async () => {
    await render(colourLight, orange);
    const slider = input("Lamp brightness").parentElement!;
    place(slider, 96, 200);
    await act(async () => {
      pointer(slider, "pointerdown", 48, 100);
      pointer(slider, "pointerup", 48, 150);
    });
    expect(input("Lamp brightness").value).toBe("25");
    await render(colourLight, orange, { failures: 1 });
    expect(input("Lamp brightness").value).toBe("60");
  });

  it("gives a light that only dims its brightness alone, with no tabs", async () => {
    await render(
      { brightness: true, colorTemperature: null, color: false },
      { on: true, brightness: 40 },
    );
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(input("Lamp brightness").value).toBe("40");
  });

  it("gives a switch one power button", async () => {
    await render(
      { brightness: false, colorTemperature: null, color: false },
      { on: true },
    );
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    await click(button("Lamp"));
    expect(onCommand).toHaveBeenCalledWith({ on: false });
  });

  it("shows an offline light with nothing to press but its tabs", async () => {
    await render(colourLight, orange, { disabled: true });
    const enabled = [...container.querySelectorAll("button, input")].filter(
      (each) => !(each as HTMLButtonElement).disabled,
    );
    expect(enabled.map((each) => each.getAttribute("role"))).toEqual([
      "tab",
      "tab",
    ]);
  });
});
