// @vitest-environment jsdom
import { Sun } from "lucide-react";
import { act, Suspense, use, useState } from "react";
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

function pagesNamed(labels: string[]) {
  return labels.map((label) => ({
    id: label.toLowerCase(),
    label,
    icon: Sun,
    content: <div>{label}</div>,
  }));
}

async function renderPages(labels = ["First", "Second"]) {
  await act(async () => {
    root.render(<SwipePages label="Device" pages={pagesNamed(labels)} />);
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

function expectDragStyles(offset: number | null, count = 2) {
  const panels = container.querySelectorAll<HTMLElement>("[role=tabpanel]");
  expect(panels).toHaveLength(count);
  for (const panel of panels) {
    expect(panel.style.translate).toBe(offset === null ? "" : `${offset}px`);
    expect(panel.style.transition).toBe(offset === null ? "" : "none");
    expect(panel.style.willChange).toBe(offset === null ? "" : "transform");
  }
}

it("leaves sideways scrollbar drags with the scrollbar until release", async () => {
  await renderPages();
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
  const touched = await renderPages();
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
  });
  expectDragStyles(-100);

  await act(async () => pointer(surface, "pointerup", 200));
  expect(currentPage()).toBe("Second");
  expect(container.querySelector("[data-swiping]")).toBeNull();
  expectDragStyles(null);
});

it.each(["pointercancel", "lostpointercapture"])(
  "ends a swipe at its last move on %s",
  async (event) => {
    const touched = await renderPages();
    for (const [x, page] of [
      [260, "First"],
      [200, "Second"],
    ] as const) {
      await act(async () => {
        pointer(touched, "pointerdown", 300);
        pointer(touched, "pointermove", 280);
      });
      const surface = container.querySelector("[data-swiping]")!.parentElement!;
      await act(async () => pointer(surface, "pointermove", x));
      expectDragStyles(x - 300);

      await act(async () => pointer(surface, event, 0));
      expect(currentPage()).toBe(page);
      expect(container.querySelector("[data-swiping]")).toBeNull();
      expectDragStyles(null);
    }
  },
);

it("gives a page added during a swipe the current drag offset", async () => {
  const touched = await renderPages();
  await act(async () => {
    pointer(touched, "pointerdown", 300);
    pointer(touched, "pointermove", 200);
  });
  await renderPages(["First", "New", "Second"]);
  expectDragStyles(-100, 3);

  await act(async () => pointer(touched, "pointerup", 200));
  expect(currentPage()).toBe("New");
  expectDragStyles(null, 3);
});

it("shows the selected page while its parent update is pending", async () => {
  let resolve!: () => void;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  function Parent() {
    const [page, setPage] = useState("first");
    if (page === "second") use(ready);
    return (
      <div data-parent-page={page}>
        <SwipePages
          label="Device"
          pages={pagesNamed(["First", "Second"])}
          onPageChange={setPage}
        />
      </div>
    );
  }
  await act(async () => {
    root.render(
      <Suspense fallback={<p>Loading</p>}>
        <Parent />
      </Suspense>,
    );
  });

  const tab = container.querySelector<HTMLButtonElement>(
    '[role="tab"][aria-label="Second"]',
  )!;
  await act(async () => tab.click());

  expect(container.textContent).not.toContain("Loading");
  expect(currentPage()).toBe("Second");
  expect(
    container.querySelector(
      "[role=tabpanel]:not([inert]) [data-slot=swipe-page-content]",
    )?.textContent,
  ).toBe("Second");
  expect(container.querySelector("[data-parent-page=first]")).not.toBeNull();

  await act(async () => resolve());
  expect(container.querySelector("[data-parent-page=second]")).not.toBeNull();
});

it("scrolls tabs too many for the width to keep the current one in view", async () => {
  // Eight 44 px tabs 20 px apart, after 24 px of room, in a 360 px row.
  const at = (index: number) => 24 + index * 64;
  // jsdom lays nothing out; these stand in for the row's layout.
  // The row says its size once it is observed, as a browser's does.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        this.callback();
      }
      disconnect() {}
    },
  );
  const saved = (
    ["offsetLeft", "offsetWidth", "clientWidth", "scrollWidth"] as const
  ).map(
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
    // 24 px of room, eight tabs and 24 px more.
    ["scrollWidth", () => 24 + 7 * 64 + 44 + 24],
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

    await act(async () => vi.advanceTimersByTime(1));
    expect(drawn()).toEqual(["Second"]);

    await act(async () => vi.advanceTimersToNextFrame());
    expect(drawn()).toEqual(["Second"]);

    await act(async () => vi.advanceTimersByTime(1));
    expect(drawn()).toEqual(["First", "Second", "Third"]);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["swipe", "tab"])(
  "keeps both pages mounted when a %s changes pages before the first frame",
  async (input) => {
    vi.useFakeTimers();
    try {
      const first = await renderPages();
      const content = () => [
        ...container.querySelectorAll("[data-slot=swipe-page-content]"),
      ];
      expect(content()).toEqual([first]);

      if (input === "swipe") {
        await act(async () => {
          pointer(first, "pointerdown", 300);
          pointer(first, "pointermove", 200);
        });
        expect(content().map((page) => page.textContent)).toEqual([
          "First",
          "Second",
        ]);
        await act(async () => pointer(first, "pointerup", 200));
      } else {
        const tab = container.querySelector<HTMLButtonElement>(
          '[role="tab"][aria-label="Second"]',
        )!;
        await act(async () => tab.click());
      }

      expect(currentPage()).toBe("Second");
      expect(content()).toHaveLength(2);
      expect(content()[0]).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  },
);

it("measures no tabs while they fit", async () => {
  const offsetLeft = vi.fn(() => 0);
  const saved = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetLeft",
  );
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get: offsetLeft,
  });
  try {
    await renderTwoPages();
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    await act(async () => tabs[1]!.click());
    expect(currentPage()).toBe("Second");
    expect(offsetLeft).not.toHaveBeenCalled();
  } finally {
    if (saved)
      Object.defineProperty(HTMLElement.prototype, "offsetLeft", saved);
    else Reflect.deleteProperty(HTMLElement.prototype, "offsetLeft");
  }
});

it("makes the page it left unreachable once the pages have slid", async () => {
  vi.useFakeTimers();
  try {
    await renderTwoPages();
    const [first, second] = [
      ...container.querySelectorAll<HTMLElement>("[role=tabpanel]"),
    ];
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    await act(async () => tabs[1]!.click());
    expect(currentPage()).toBe("Second");
    // While they slide, the page left stays as it was.
    expect(first!.hasAttribute("inert")).toBe(false);
    expect(second!.hasAttribute("inert")).toBe(true);

    await act(async () => vi.advanceTimersByTime(300));
    expect(first!.hasAttribute("inert")).toBe(true);
    expect(second!.hasAttribute("inert")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
