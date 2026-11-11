// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Overlay } from "../src/overlay";

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

// The fade the built CSS gives it, which jsdom doesn't know.
function withFade() {
  const computed = window.getComputedStyle.bind(window);
  vi.stubGlobal("CSS", { escape: (name: string) => name });
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    element.getAttribute("role") === "dialog"
      ? ({
          get animationName() {
            return element.getAttribute("data-state") === "closed"
              ? "exit"
              : "enter";
          },
        } as CSSStyleDeclaration)
      : computed(element),
  );
}

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

    await act(async () => {
      dialog()!.dispatchEvent(
        Object.assign(new Event("animationend"), { animationName: "exit" }),
      );
    });

    expect(dialog()).toBeNull();
    expect(onCovering.mock.calls).toEqual([[true], [false]]);
  });

  it("says it has gone if it goes away while open", async () => {
    await show(true);

    await act(async () => root.render(null));

    expect(onCovering.mock.calls).toEqual([[true], [false]]);
  });
});

// What the frame's backing goes by (src/shell-frame.css): `:has(> .overlay…)`
// needs it a direct child of the screen, and its state to change as it starts
// to fade, so the two fade together.
describe("what the frame's backing under the glass goes by", () => {
  it("is a direct child of its container, open only until it starts to fade", async () => {
    withFade();
    await show(true);
    expect(dialog()!.parentElement).toBe(container);
    expect(dialog()!.matches(".overlay[data-state=open]")).toBe(true);

    await show(false);

    expect(dialog()).not.toBeNull();
    expect(dialog()!.matches(".overlay[data-state=open]")).toBe(false);
  });
});
