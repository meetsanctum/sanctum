import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { cn } from "cn";

import { Button, buttonVariants } from "../src/components/ui/button";

vi.mock("cn", async (original) => {
  const actual = await original<typeof import("cn")>();
  return { ...actual, cn: vi.fn(actual.cn) };
});

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
    [{ variant: "ghost", size: "sm" }, undefined],
    [{ variant: "outline", size: "lg" }, undefined],
    [{ variant: "ghost", size: "bar" }, "ms-auto self-start"],
  ] as const)(
    "are the variants' classes, merged: %o %s",
    (options, className) => {
      const expected = cn(buttonVariants({ ...options, className }));
      expect(
        classOf(
          renderToStaticMarkup(
            <Button {...options} className={className}>
              Go
            </Button>,
          ),
        ),
      ).toBe(expected);
    },
  );

  it("uses the last of two competing placement classes", () => {
    const classes = classOf(
      renderToStaticMarkup(<Button className="ms-2 ms-auto">Go</Button>),
    )!.split(" ");
    expect(classes.filter((each) => each.startsWith("ms-"))).toEqual([
      "ms-auto",
    ]);
  });

  it("merges classes only once for the same variant, size and placement", () => {
    const draw = () =>
      renderToStaticMarkup(
        <Button variant="outline" size="lg" className="self-end">
          Go
        </Button>,
      );
    const merge = vi.mocked(cn);
    merge.mockClear();
    const first = draw();
    expect(merge).toHaveBeenCalledTimes(1);
    expect(draw()).toBe(first);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("recomputes earlier classes when the cache fills", () => {
    const draw = (className: string) =>
      renderToStaticMarkup(<Button className={className}>Go</Button>);
    const first = draw("order-first");
    for (let index = 0; index < 1000; index += 1) {
      draw(`order-[${index}]`);
    }

    const merge = vi.mocked(cn);
    merge.mockClear();
    expect(draw("order-first")).toBe(first);
    expect(merge).toHaveBeenCalledTimes(1);
  });
});
