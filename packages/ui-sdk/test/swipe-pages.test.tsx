// @vitest-environment jsdom
import { Sun } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SwipePages } from "../src/swipe-pages";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom does not lay out the viewport; the test only needs its track.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderTwoPages() {
  await act(async () => {
    root.render(
      <SwipePages
        label="Device"
        pages={["First", "Second"].map((label) => ({
          id: label.toLowerCase(),
          label,
          icon: Sun,
          content: <div>{label}</div>,
        }))}
      />,
    );
  });
  return container.querySelector<HTMLElement>(
    "[data-slot=swipe-page-content]",
  )!;
}

function pointer(target: Element, type: string, x: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX: x,
    clientY: 100,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}

const currentPage = () =>
  container
    .querySelector('[role=tab][aria-selected="true"]')
    ?.getAttribute("aria-label");

it("leaves sideways scrollbar drags with the scrollbar until release", async () => {
  await renderTwoPages();
  const viewport = container.querySelector<HTMLElement>(
    "[data-slot=scroll-area-viewport]",
  )!;
  await act(async () => {
    viewport.scrollTop = 10;
    viewport.dispatchEvent(new Event("scroll"));
  });
  const scrollbar = container.querySelector<HTMLElement>(
    "[data-slot=scroll-area-scrollbar]",
  )!;
  expect(scrollbar).not.toBeNull();
  scrollbar.setPointerCapture = vi.fn();
  scrollbar.hasPointerCapture = vi.fn(() => true);
  scrollbar.releasePointerCapture = vi.fn();
  await act(async () => {
    pointer(scrollbar, "pointerdown", 300);
    pointer(scrollbar, "pointermove", 200);
  });
  const isSwiping = container.querySelector("[data-swiping]") !== null;
  await act(async () => pointer(scrollbar, "pointerup", 200));

  expect(isSwiping).toBe(false);
  expect(currentPage()).toBe("First");
  expect(scrollbar.releasePointerCapture).toHaveBeenCalledWith(1);
});

it("keeps a finger's swipe when the touched element's capture ends", async () => {
  const touched = await renderTwoPages();
  await act(async () => {
    pointer(touched, "pointerdown", 300);
    pointer(touched, "pointermove", 280);
  });
  const surface = container.querySelector("[data-swiping]")!.parentElement!;
  await act(async () => {
    // A touch holds an implicit capture on what it touched; when the swipe
    // takes capture, that element loses it and the event bubbles up.
    pointer(touched, "lostpointercapture", 280);
    pointer(surface, "pointermove", 200);
    pointer(surface, "pointerup", 200);
  });

  expect(currentPage()).toBe("Second");
});

it.each(["pointercancel", "lostpointercapture"])(
  "ends a swipe at its last move on %s",
  async (event) => {
    const touched = await renderTwoPages();
    for (const [x, page] of [
      [260, "First"],
      [200, "Second"],
    ] as const) {
      await act(async () => {
        pointer(touched, "pointerdown", 300);
        pointer(touched, "pointermove", 280);
      });
      const surface = container.querySelector("[data-swiping]")!.parentElement!;
      await act(async () => {
        pointer(surface, "pointermove", x);
        pointer(surface, event, 0);
      });
      expect(currentPage()).toBe(page);
      expect(container.querySelector("[data-swiping]")).toBeNull();
    }
  },
);

it("scrolls tabs too many for the width to keep the current one in view", async () => {
  // Eight 44 px tabs 20 px apart, after 24 px of room, in a 360 px row.
  const at = (index: number) => 24 + index * 64;
  // jsdom lays nothing out; these stand in for the row's layout.
  const saved = (["offsetLeft", "offsetWidth", "clientWidth"] as const).map(
    (name) =>
      [
        name,
        Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
      ] as const,
  );
  for (const [name, value] of [
    [
      "offsetLeft",
      function (this: HTMLElement) {
        const tabs = [...(this.parentElement?.children ?? [])];
        return at(tabs.indexOf(this));
      },
    ],
    ["offsetWidth", () => 44],
    ["clientWidth", () => 360],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get: value,
    });
  }
  try {
    await act(async () => {
      root.render(
        <SwipePages
          label="Device"
          pages={Array.from({ length: 8 }, (_, index) => ({
            id: `page-${index}`,
            label: `Page ${index}`,
            icon: Sun,
            content: <div>Page {index}</div>,
          }))}
        />,
      );
    });
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    const row = tabs[0]!.closest("[role=tablist]")!.parentElement!;
    expect(row.scrollLeft).toBe(0);

    await act(async () => {
      tabs[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    // The last tab ends at 24 + 7 × 64 + 44 = 516, and 24 px of fade
    // follows it.
    expect(row.scrollLeft).toBe(516 + 24 - 360);

    await act(async () => tabs[1]!.click());
    expect(row.scrollLeft).toBe(at(1) - 24);
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor)
        Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  }
});

it("draws the page on show at once and the others once it has painted", async () => {
  vi.useFakeTimers();
  try {
    await act(async () => {
      root.render(
        <SwipePages
          label="Device"
          initial="second"
          pages={["First", "Second", "Third"].map((label) => ({
            id: label.toLowerCase(),
            label,
            icon: Sun,
            content: <p>{label}</p>,
          }))}
        />,
      );
    });
    const drawn = () =>
      [...container.querySelectorAll("p")].map((each) => each.textContent);
    expect(drawn()).toEqual(["Second"]);
    expect(container.querySelectorAll("[role=tabpanel]")).toHaveLength(3);

    await act(async () => vi.advanceTimersByTime(20));
    expect(drawn()).toEqual(["First", "Second", "Third"]);
  } finally {
    vi.useRealTimers();
  }
});
