// @vitest-environment jsdom
import { Pencil } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "../src/components/ui/button";
import { PageBar, PageBarButton, PageBarSlot } from "../src/page-bar";

let container: HTMLDivElement;
let slot: HTMLDivElement;
let root: Root;

// A device as wide as `width`, as matchMedia answers for it.
function screenWidth(width: number) {
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(width < 40rem)" && width < 640,
    addEventListener: (_event: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) =>
      listeners.delete(listener),
  }));
  return (nextWidth: number) => {
    width = nextWidth;
    for (const listener of [...listeners]) listener();
  };
}

async function render(inShell: boolean) {
  await act(async () => {
    root.render(
      <PageBarSlot.Provider value={inShell ? slot : null}>
        <PageBar title="New automation">
          <Button variant="outline">Cancel</Button>
          <PageBarButton icon={Pencil} label="Edit" />
          <PageBarButton primary icon={Pencil} label="Save" />
        </PageBar>
      </PageBarSlot.Provider>,
    );
  });
}

const titleIn = (element: HTMLElement) =>
  element.querySelector("h1")?.textContent;
const buttonsIn = (element: HTMLElement) =>
  [...element.querySelectorAll("button")].map((button) => [
    button.textContent,
    button.getAttribute("aria-label"),
  ]);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  slot = document.createElement("div");
  document.body.append(container, slot);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  slot.remove();
  vi.unstubAllGlobals();
});

describe("in the shell", () => {
  it.each([0, 1, 2])(
    "keeps button %i focused when crossing the phone breakpoint",
    async (index) => {
      const resize = screenWidth(640);
      await render(true);
      const button = slot.querySelectorAll("button")[index]!;
      button.focus();

      for (const width of [639, 640]) {
        await act(async () => resize(width));
        expect(titleIn(width < 640 ? container : slot)).toBe("New automation");
        expect(titleIn(width < 640 ? slot : container)).toBeUndefined();
        expect(slot.querySelectorAll("button")[index]).toBe(button);
        expect(document.activeElement).toBe(button);
      }
    },
  );

  it("puts the title and the buttons in the top bar", async () => {
    screenWidth(1280);
    await render(true);
    expect(titleIn(slot)).toBe("New automation");
    expect(titleIn(container)).toBeUndefined();
    expect(buttonsIn(slot)).toEqual([
      ["Cancel", null],
      ["Edit", null],
      ["Save", null],
    ]);
  });

  it("opens the page with the title on a phone, its icons alone in the bar", async () => {
    screenWidth(390);
    await render(true);
    expect(titleIn(container)).toBe("New automation");
    expect(titleIn(slot)).toBeUndefined();
    expect(buttonsIn(slot)).toEqual([
      ["Cancel", null],
      ["", "Edit"],
      ["", "Save"],
    ]);
  });
});

it("makes a header of its own outside the shell", async () => {
  screenWidth(390);
  await render(false);
  expect(container.querySelector("header h1")?.textContent).toBe(
    "New automation",
  );
  expect(buttonsIn(container)).toEqual([
    ["Cancel", null],
    ["", "Edit"],
    ["", "Save"],
  ]);
  expect(slot.childElementCount).toBe(0);
});
