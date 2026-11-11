import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppIcon } from "../src/app-icon";

it.each(["unknown-glyph", "constructor"])(
  "uses the default icon for an unknown glyph: %s",
  (glyph) => {
    expect(
      renderToStaticMarkup(<AppIcon icon={{ glyph, color: "ember" }} />),
    ).toContain("lucide-app-window");
  },
);

describe("approved app artwork", () => {
  it.each([
    ["settings", "graphite", "settings"],
    ["swatch-book", "ember", "moods"],
    ["sparkles", "blossom", "automations"],
    ["cloud-sun", "sky", "weather"],
    ["sun", "sun", "natural-light"],
    ["radio-tower", "graphite", "zigbee"],
  ] as const)("renders %s/%s as %s artwork", (glyph, color, asset) => {
    const markup = renderToStaticMarkup(<AppIcon icon={{ glyph, color }} />);
    expect(markup).toContain(`/app-icons/${asset}.webp`);
    expect(markup).toContain('alt=""');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("background:");
  });

  it("keeps the requested size when rendering artwork", () => {
    const markup = renderToStaticMarkup(
      <AppIcon
        icon={{ glyph: "settings", color: "graphite" }}
        className="size-6"
      />,
    );
    expect(markup).toContain("size-6");
    expect(markup).toContain("size-full");
    expect(markup).toContain('width="256" height="256"');
  });

  it("keeps a known glyph on its requested colour without borrowing another app's artwork", () => {
    const markup = renderToStaticMarkup(
      <AppIcon icon={{ glyph: "sparkles", color: "iris" }} />,
    );
    expect(markup).toContain("lucide-sparkles");
    expect(markup).toContain("background:var(--iris)");
    expect(markup).not.toContain("<img");
  });
});
