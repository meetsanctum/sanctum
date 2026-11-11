import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
});
