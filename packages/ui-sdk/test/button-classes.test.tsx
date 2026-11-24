import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { cn } from "cn";

import { Button, buttonVariants } from "../src/components/ui/button";

// A button's classes are made once for each variant, size and class, and
// come out as they always did, a call site's class winning a conflict.

const classOf = (markup: string) =>
  /class="([^"]*)"/
    .exec(markup)?.[1]
    ?.replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'");

describe("a button's classes", () => {
  it.each([
    [{}, undefined],
    [{ variant: "outline", size: "sm" }, undefined],
    [{ variant: "ghost", size: "bar" }, "ms-auto px-8"],
  ] as const)(
    "are the variants' classes, merged: %o %s",
    (options, className) => {
      const expected = cn(buttonVariants({ ...options, className }));
      for (let drawn = 0; drawn < 2; drawn++) {
        expect(
          classOf(
            renderToStaticMarkup(
              <Button {...options} className={className}>
                Go
              </Button>,
            ),
          ),
        ).toBe(expected);
      }
    },
  );

  it("lets a call site's class win", () => {
    const classes = classOf(
      renderToStaticMarkup(<Button className="px-8">Go</Button>),
    )!.split(" ");
    expect(classes).toContain("px-8");
    expect(classes.filter((each) => /^px-/.test(each))).toEqual(["px-8"]);
  });
});
