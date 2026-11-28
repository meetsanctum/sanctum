import { cn } from "cn";
import { expect, it } from "vitest";

import { buttonVariants } from "../src/components/ui/button";
import { contrast, themeRgb, themeTokens } from "./theme-colours";

it.each(["day", "evening"])(
  "keeps problem text at 4.5:1 contrast on a card in %s mode",
  (mode) => {
    const tokens = themeTokens(mode);
    const text = themeRgb(tokens, "--color-destructive");
    const card = themeRgb(tokens, "--color-card");
    expect(contrast(text, card)).toBeGreaterThanOrEqual(4.5);
  },
);

it.each(["day", "evening"])(
  "keeps a destructive button at 4.5:1 contrast on a card at rest and on hover in %s mode",
  (mode) => {
    const classes = cn(buttonVariants({ variant: "destructive" })).split(" ");
    expect(classes).toContain("text-destructive");
    expect(classes).toContain("hover:text-destructive");
    // These are the only fills at rest or on hover. In Evening the card
    // shows through the button, and in Day the button has its own fill.
    expect(classes.filter((name) => /(^|:)bg-(?!clip-)/.test(name))).toEqual([
      "bg-background",
      "dark:bg-transparent",
    ]);
    const tokens = themeTokens(mode);
    const surface = mode === "day" ? "--color-background" : "--color-card";
    expect(
      contrast(
        themeRgb(tokens, "--color-destructive"),
        themeRgb(tokens, surface),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  },
);
