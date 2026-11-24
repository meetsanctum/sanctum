// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { useReducedEffects } from "../src/reduce-effects";

// Whether the page draws with Reduce effects, as its <html> says, followed
// as it changes.

afterEach(() => {
  delete document.documentElement.dataset.effects;
  vi.unstubAllGlobals();
});

it("follows what <html> says", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const seen: boolean[] = [];
  function Probe() {
    seen.push(useReducedEffects());
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  expect(seen.at(-1)).toBe(false);

  await act(async () => {
    document.documentElement.dataset.effects = "reduced";
  });
  expect(seen.at(-1)).toBe(true);

  await act(async () => {
    delete document.documentElement.dataset.effects;
  });
  expect(seen.at(-1)).toBe(false);
  await act(async () => root.unmount());
});
