import { act } from "react";
import { vi } from "vitest";

const exitAnimation = "exit";

// Simulate the dialog animations supplied by the built CSS.
export function withFade() {
  const computed = window.getComputedStyle.bind(window);
  vi.stubGlobal("CSS", { escape: (name: string) => name });
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    element.getAttribute("role") === "dialog"
      ? ({
          get animationName() {
            return element.getAttribute("data-state") === "closed"
              ? exitAnimation
              : "enter";
          },
        } as CSSStyleDeclaration)
      : computed(element),
  );
}

export function finishFade(dialog: Element) {
  return act(async () => {
    dialog.dispatchEvent(
      Object.assign(new Event("animationend"), {
        animationName: exitAnimation,
      }),
    );
  });
}
