// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { knotPath } from "../src/knot";
import { KnotLoader } from "../src/knot-loader";

describe("the knot loader's markup", () => {
  // Inside a mask, WebKit draws nothing through a clip path of several shapes,
  // so the knot opened no gaps there, and no test here runs WebKit. A polygon,
  // because the stylesheet's rule for the line's paths would animate a path.
  it("clips each line's cuts with one polygon", () => {
    const markup = renderToStaticMarkup(<KnotLoader />);
    const clipPaths = [
      ...markup.matchAll(/<clipPath[^>]*>(.*?)<\/clipPath>/g),
    ].map(([, shapes]) => shapes!.match(/<[a-z]+/g));
    expect(clipPaths).toEqual([["<polygon"], ["<polygon"]]);
  });

  it("draws the knot without masks while Reduce effects is on", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<KnotLoader />));
      expect(container.querySelectorAll("path[mask]")).toHaveLength(2);
      await act(async () => {
        document.documentElement.dataset.effects = "reduced";
      });
      expect(container.querySelector("mask, [mask]")).toBeNull();
      expect(container.querySelector("path")?.getAttribute("d")).toBe(knotPath);
      await act(async () => {
        delete document.documentElement.dataset.effects;
      });
      expect(container.querySelectorAll("path[mask]")).toHaveLength(2);
    } finally {
      await act(async () => root.unmount());
      delete document.documentElement.dataset.effects;
      vi.unstubAllGlobals();
    }
  });
});
