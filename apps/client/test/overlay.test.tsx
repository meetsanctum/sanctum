// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WeekColumnsChart } from "@meetsanctum/ui-sdk/charts";

import { Overlay } from "../src/overlay";
import { finishFade, withFade } from "./overlay-fade";

// How long an overlay says it covers the window, which keeps the macOS
// traffic lights hidden (src/sidebar-state.ts).

let root: Root;
let container: HTMLDivElement;
const onCovering = vi.fn<(covering: boolean) => void>();

const show = (open: boolean) =>
  act(async () => {
    root.render(
      <Overlay
        container={container}
        open={open}
        onClose={() => {}}
        onCovering={onCovering}
        title="Office light"
      >
        A page
      </Overlay>,
    );
  });

const dialog = () => container.querySelector('[role="dialog"]');

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onCovering.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("uses the shared frosted blur that turns off under Reduce effects", async () => {
  await show(true);

  const classes = [...dialog()!.classList];
  expect(classes).toContain("frosted");
  expect(classes.some((name) => name.includes("backdrop-blur"))).toBe(false);
});

it("disables both dialog fades under Reduce effects", async () => {
  await show(true);

  expect([...dialog()!.classList]).toEqual(
    expect.arrayContaining([
      "reduce-effects:data-open:animate-none",
      "reduce-effects:data-closed:animate-none",
    ]),
  );
});

describe("what an overlay says about covering the window", () => {
  it("says nothing while it is closed", async () => {
    await show(false);

    expect(onCovering).not.toHaveBeenCalled();
  });

  it("says it covers the window as it opens, and has gone as it closes", async () => {
    await show(true);
    expect(onCovering.mock.calls).toEqual([[true]]);

    await show(false);
    expect(onCovering.mock.calls).toEqual([[true], [false]]);
  });

  it("still covers the window until its fade out has ended", async () => {
    withFade();
    await show(true);
    await show(false);
    expect(dialog()).not.toBeNull();
    expect(onCovering.mock.calls).toEqual([[true]]);

    await finishFade(dialog()!);

    expect(dialog()).toBeNull();
    expect(onCovering.mock.calls).toEqual([[true], [false]]);
  });

  it("says it has gone if it goes away while open", async () => {
    await show(true);

    await act(async () => root.render(null));

    expect(onCovering.mock.calls).toEqual([[true], [false]]);
  });
});

// What the frame's backing goes by (src/shell-frame.css): its container says
// it is covered while the overlay is open, and not once it starts to fade,
// so the two fade together.
describe("what the frame's backing under the glass goes by", () => {
  it("marks its container covered while open, and not once it starts to fade", async () => {
    withFade();
    await show(true);
    expect(dialog()!.parentElement).toBe(container);
    expect(container.hasAttribute("data-covered")).toBe(true);

    await show(false);

    expect(dialog()).not.toBeNull();
    expect(container.hasAttribute("data-covered")).toBe(false);
  });
});

describe("a container two overlays cover", () => {
  it("stays covered until the last of them closes", async () => {
    const both = (first: boolean, second: boolean) =>
      act(async () => {
        root.render(
          <>
            {[first, second].map((open, index) => (
              <Overlay
                key={index}
                container={container}
                open={open}
                onClose={() => {}}
                onCovering={() => {}}
                title={`Overlay ${index}`}
              >
                A page
              </Overlay>
            ))}
          </>,
        );
      });

    await both(true, true);
    expect(container.hasAttribute("data-covered")).toBe(true);
    expect(container.hasAttribute("data-holds-pointer")).toBe(true);
    await both(false, true);
    expect(container.hasAttribute("data-covered")).toBe(true);
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.hasAttribute("data-holds-pointer")).toBe(true);
    await both(false, false);
    expect(container.hasAttribute("data-covered")).toBe(false);
    expect(container.hasAttribute("data-holds-pointer")).toBe(false);
  });
});

// Radix turns pointer events off on <body> while the dialog is open, which
// every element inherits; the container keeps its own from before that until
// after it ends, so nothing behind the veil is styled again
// (src/shell-frame.css).
describe("pointer events behind the veil", () => {
  it("holds its container's before Radix turns them off, and until after it turns them back on", async () => {
    withFade();
    const seen: string[] = [];
    const note = (records: MutationRecord[]) => {
      // What each change made of it, from what it was before.
      for (const record of records) {
        seen.push(
          record.target === document.body
            ? `body ${record.oldValue?.includes("pointer-events: none") ? "auto" : "none"}`
            : `container ${record.oldValue === null ? "holds" : "lets go"}`,
        );
      }
    };
    const watch = new MutationObserver(note);
    watch.observe(document.body, {
      attributeFilter: ["style"],
      attributeOldValue: true,
    });
    watch.observe(container, {
      attributeFilter: ["data-holds-pointer"],
      attributeOldValue: true,
    });

    await show(true);
    expect(container.hasAttribute("data-holds-pointer")).toBe(true);
    expect(document.body.style.pointerEvents).toBe("none");

    await show(false);
    expect(document.body.style.pointerEvents).toBe("");
    expect(container.hasAttribute("data-holds-pointer")).toBe(true);

    await finishFade(dialog()!);
    expect(container.hasAttribute("data-holds-pointer")).toBe(false);

    note(watch.takeRecords());
    watch.disconnect();
    expect(seen.filter((each, index) => each !== seen[index - 1])).toEqual([
      "container holds",
      "body none",
      "body auto",
      "container lets go",
    ]);
  });
});

it("leaves the first Escape to a pinned chart and closes on the next", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const onClose = vi.fn();
  const day = 24 * 60 * 60_000;
  const now = Date.parse("2026-11-18T15:30:00Z");
  await act(async () => {
    root.render(
      <Overlay
        container={container}
        open
        onClose={onClose}
        onCovering={onCovering}
        title="Office door"
      >
        <WeekColumnsChart
          days={[2, 1, 0].map((back) => ({
            start: now - back * day,
            value: 3,
          }))}
          now={now}
          scale="counts"
          label="How often it opened each day"
          text={(each) => `${each.value} times`}
          spoken={(each) => `opened ${each.value} times`}
          width={340}
        />
      </Overlay>,
    );
  });
  const chart = container.querySelector<HTMLElement>('[role="group"]')!;
  const escape = () =>
    act(async () => {
      chart.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  await act(async () => {
    chart.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 50, detail: 1 }),
    );
  });
  expect(chart.hasAttribute("data-pinned")).toBe(true);

  await escape();
  expect(chart.hasAttribute("data-pinned")).toBe(false);
  expect(onClose).not.toHaveBeenCalled();

  await escape();
  expect(onClose).toHaveBeenCalledOnce();
});
