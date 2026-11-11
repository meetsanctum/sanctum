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

it("leaves sideways scrollbar drags with the scrollbar until release", async () => {
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
  const pointer = (type: string, x: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: 100,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    scrollbar.dispatchEvent(event);
  };
  await act(async () => {
    pointer("pointerdown", 300);
    pointer("pointermove", 200);
  });
  const isSwiping = container.querySelector("[data-swiping]") !== null;
  await act(async () => pointer("pointerup", 200));

  expect(isSwiping).toBe(false);
  expect(
    container
      .querySelector('[role=tab][aria-selected="true"]')
      ?.getAttribute("aria-label"),
  ).toBe("First");
  expect(scrollbar.releasePointerCapture).toHaveBeenCalledWith(1);
});
