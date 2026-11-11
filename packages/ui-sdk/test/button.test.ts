import { describe, expect, it } from "vitest";

import { buttonVariants } from "../src/components/ui/button";

const sizes = [
  "default",
  "sm",
  "lg",
  "chip",
  "icon-sm",
  "icon-lg",
  "bar",
  "item",
  "tile",
  "app",
  "row",
  "option",
  "label",
  "inline",
  "avatar",
] as const;

describe("Button", () => {
  it("is pill-shaped in no size but the avatar's", () => {
    for (const size of sizes) {
      const round = buttonVariants({ size }).includes("rounded-full");
      expect([size, round]).toEqual([size, size === "avatar"]);
    }
  });

  it("draws the top bar's 36 px with the pins' corners, pressable in the 44 px around it", () => {
    const bar = buttonVariants({ variant: "ghost", size: "bar" });
    expect(bar).toContain("size-9");
    expect(bar).toContain("rounded-sm");
    expect(bar).toContain("before:-inset-1");
  });

  it("marks a ghost only while the menu it opens is open, so a toggle stays a ghost", () => {
    const ghost = buttonVariants({ variant: "ghost" });
    expect(ghost).toContain(
      "[&[aria-haspopup][aria-expanded=true]]:bg-foreground/12",
    );
    expect(ghost).not.toMatch(/(^| )aria-expanded:bg-/);
  });

  it("turns the ink where a button is the place on show, on or chosen", () => {
    expect(buttonVariants({ variant: "ghost" })).toContain(
      "aria-[current=page]:bg-foreground",
    );
    expect(buttonVariants({ variant: "tile" })).toContain(
      "aria-checked:bg-foreground",
    );
    expect(buttonVariants({ variant: "outline" })).toContain(
      "data-on:bg-foreground",
    );
  });
});
