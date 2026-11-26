// @vitest-environment jsdom
import { Sun } from "lucide-react";
import { act, Suspense, use, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pagesNamed(labels: string[]) {
  return labels.map((label) => ({
    id: label.toLowerCase().replaceAll(" ", "-"),
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

function pointer(
  target: Element,
  type: string,
  x: number,
  pointerType: "touch" | "mouse" = "touch",
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: 100,
      pointerId: 1,
      pointerType,
      isPrimary: true,
    }),
  );
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
      '[role=tabpanel][id$="-second"] [data-slot=swipe-page-content]',
    )?.textContent,
  ).toBe("Second");
  expect(container.querySelector("[data-parent-page=first]")).not.toBeNull();

  await act(async () => resolve());
  expect(container.querySelector("[data-parent-page=second]")).not.toBeNull();
});

async function renderWideTabRow(clientWidth: () => number, initial?: string) {
  // Eight 44 px tabs 20 px apart with 24 px of room at both ends.
  const labels = Array.from({ length: 8 }, (_, index) => `Page ${index}`);
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(
    function (this: HTMLElement) {
      const siblings = [...(this.parentElement?.children ?? [])];
      return 24 + siblings.indexOf(this) * 64;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(44);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    clientWidth,
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(540);
  await act(async () => {
    root.render(
      <SwipePages
        label="Device"
        initial={initial}
        pages={pagesNamed(labels)}
      />,
    );
  });
  const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
  const row = tabs[0]!.closest("[role=tablist]")!.parentElement!;
  return { tabs, row };
}

it("keeps the selected tab clear of the fade when the row narrows", async () => {
  let rowWidth = 540;
  let resizeRow: (() => void) | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe(element: Element) {
        if (element.firstElementChild?.getAttribute("role") === "tablist") {
          resizeRow = this.callback;
        }
        this.callback();
      }
      disconnect() {}
    },
  );
  const { tabs, row } = await renderWideTabRow(() => rowWidth);
  expect(row.scrollLeft).toBe(0);
  await act(async () => {
    tabs[0]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
  });
  expect(currentPage()).toBe("Page 7");
  expect(row.scrollLeft).toBe(0);

  rowWidth = 360;
  await act(async () => resizeRow!());
  // The last tab ends at 516 px, with another 24 px for the fade.
  expect(row.scrollLeft).toBe(540 - rowWidth);

  await act(async () => tabs[1]!.click());
  expect(row.scrollLeft).toBe(64);
});

it("scrolls to the initial tab without ResizeObserver", async () => {
  vi.stubGlobal("ResizeObserver", undefined);
  const { row } = await renderWideTabRow(() => 360, "page-7");
  expect(currentPage()).toBe("Page 7");
  expect(row.scrollLeft).toBe(540 - 360);
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
    await renderPages();
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

it("makes the selected page reachable at once, and the page left once the pages have slid", async () => {
  vi.useFakeTimers();
  try {
    await renderPages();
    const [first, second] = [
      ...container.querySelectorAll<HTMLElement>("[role=tabpanel]"),
    ];
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    await act(async () => tabs[1]!.click());
    expect(currentPage()).toBe("Second");
    // A tap on the page sliding in lands there.
    expect(second!.hasAttribute("inert")).toBe(false);
    expect(first!.hasAttribute("inert")).toBe(false);

    await act(async () => vi.advanceTimersByTime(300));
    expect(first!.hasAttribute("inert")).toBe(true);
    expect(second!.hasAttribute("inert")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

describe("with Reduce motion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.dataset.motion = "reduced";
  });

  afterEach(() => {
    delete document.documentElement.dataset.motion;
    vi.useRealTimers();
  });

  const panels = () =>
    container.querySelectorAll<HTMLElement>("[role=tabpanel]");

  async function swipe(pointerType: "touch" | "mouse" = "touch") {
    const touched = await renderPages(["First", "Second", "Third"]);
    await act(async () => {
      pointer(touched, "pointerdown", 300, pointerType);
      pointer(touched, "pointermove", 200, pointerType);
    });
    await act(async () => pointer(touched, "pointerup", 200, pointerType));
    expect(currentPage()).toBe("Second");
  }

  it("slides pages on from the finger's drag offset", async () => {
    await swipe();
    for (const panel of panels()) {
      expect(panel.style.transition).toMatch(/^transform 300ms/);
      expect(panel.style.transition).toContain(", translate 300ms ");
      expect(panel.style.translate).toBe("");
    }

    await act(async () => vi.advanceTimersByTime(300));
    for (const panel of panels()) expect(panel.style.transition).toBe("");
  });

  it("slides pages a mouse dragged on to their places too", async () => {
    await swipe("mouse");
    for (const panel of panels()) {
      expect(panel.style.transition).toMatch(/^transform 300ms/);
    }
  });

  it.each(["click", "keyboard"])(
    "changes tabs in place by %s while swiped pages slide",
    async (input) => {
      await swipe();
      expect(panels()[2]!.style.transition).toMatch(/^transform 300ms/);
      const second = container.querySelector(
        '[role="tab"][aria-selected="true"]',
      )!;
      const third = container.querySelector<HTMLElement>(
        '[role="tab"][aria-label="Third"]',
      )!;
      await act(async () => {
        if (input === "click") {
          third.click();
        } else {
          second.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
          );
        }
      });
      expect(currentPage()).toBe("Third");
      for (const panel of panels()) expect(panel.style.transition).toBe("");
    },
  );
});
