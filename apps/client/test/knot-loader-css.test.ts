import { fileURLToPath } from "node:url";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

// The knot loader's motion, the top bar's fade and the frame's backing under
// the glass (src/styles.css), read from the stylesheet the production build
// emits. The dev server serves the CSS as written, but the build's minifier
// rewrites it: it once turned the paths' `animation` shorthand, which had no
// name, into `none`, and built apps showed no knot. It also reorders
// declarations, which the fade's animation timeline depends on.

type Rule = {
  media: string;
  supports: string;
  isStartingStyle: boolean;
  selectors: string[];
  declarations: string[];
};
type Animation = {
  name: string;
  duration: string;
  timingFunction: string;
  iterationCount: string;
};

const initial: Animation = {
  name: "none",
  duration: "0s",
  timingFunction: "ease",
  iterationCount: "1",
};
const longhands = new Map<string, keyof Animation>([
  ["animation-name", "name"],
  ["animation-duration", "duration"],
  ["animation-timing-function", "timingFunction"],
  ["animation-iteration-count", "iterationCount"],
]);
const timingKeywords =
  /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)$|^(cubic-bezier|steps|linear)\(/;
// The shorthand's other keywords, none of which names an animation.
const otherKeywords =
  /^(none|normal|reverse|alternate|alternate-reverse|forwards|backwards|both|running|paused)$/;

let rules: Rule[] = [];
let css = "";

beforeAll(async () => {
  const result = await build({
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "silent",
    build: { write: false, rollupOptions: { input: "src/styles.css" } },
  });
  const files = [result]
    .flat()
    .flatMap((bundle) => ("output" in bundle ? bundle.output : []));
  const stylesheet = files.find(
    (file) => file.type === "asset" && file.fileName.endsWith(".css"),
  );
  css = stylesheet?.type === "asset" ? String(stylesheet.source) : "";
  rules = styleRules(css);
}, 30_000);

describe("the knot loader's built CSS", () => {
  it.each(["upright", "lying"])(
    "draws and pulls out the %s path every 4.8 s, over and over",
    (loop) => {
      expect(
        animationOf("prefers-reduced-motion:no-preference", [
          ".knot-loader path",
          `.knot-loader .knot-${loop}`,
        ]),
      ).toMatchObject({
        name: "knot-line",
        duration: "4.8s",
        iterationCount: "infinite",
      });
    },
  );

  it("rests only on the whole knot, and keeps its speed where it vanishes", () => {
    const keyframes = /@keyframes knot-line\{.*?\}\}/.exec(css)?.[0];
    // Mirror images: stopping at the knot, and as fast at the end of pulling
    // out as at the start of drawing, so that nothing waits in between.
    expect(keyframes).toContain("cubic-bezier(.33,.67,.67,1)");
    expect(keyframes).toContain("cubic-bezier(.33,0,.67,.33)");
  });

  it("keeps both paths' dashes, so one offset drives the whole line", () => {
    expect(css).toContain("stroke-dasharray:60.3 130");
    // The trailing 0 closes a pattern that wraps round to -28.2.
    expect(css).toContain("stroke-dasharray:32.1 61 28.2 0");
  });

  it("turns the drawing a quarter with each turn of the line", () => {
    expect(
      animationOf("prefers-reduced-motion:no-preference", [".knot-loader g"]),
    ).toEqual({
      name: "knot-turns",
      duration: "19.2s",
      timingFunction: "step-end",
      iterationCount: "infinite",
    });
    expect(css).toContain("@keyframes knot-turns{");
    // Round any other point, the knot would swing out of its square.
    expect(css).toMatch(/\.knot-loader g\{[^}]*transform-origin:(center|50%)/);
  });

  it("breathes where motion is reduced", () => {
    expect(
      animationOf("prefers-reduced-motion:reduce", [".knot-loader"]),
    ).toEqual({
      name: "knot-breathe",
      duration: "2.4s",
      timingFunction: "ease-in-out",
      iterationCount: "infinite",
    });
    expect(css).toContain("@keyframes knot-breathe{");
  });
});

describe("the top bar's fade in the built CSS", () => {
  it("comes in as the page scrolls, with the screen's background", () => {
    const fade = declarationsOf(".top-fade");
    const properties = fade.map(([property]) => property);
    const at = (property: string) => properties.lastIndexOf(property);
    expect(Object.fromEntries(fade)).toMatchObject({
      background: "inherit",
      inset: "0",
      "mask-size": "100% 40px",
      "mask-position": normalise("0 var(--page-top)"),
      "mask-repeat": "no-repeat",
      opacity: "0",
      "animation-name": "top-fade-in",
      "animation-timeline": "--page",
      "animation-range": "0 24px",
    });
    // A shorthand after a longhand would undo it.
    expect(properties).not.toContain("background-attachment");
    expect(at("animation")).toBeLessThan(at("animation-timeline"));
    expect(css).toContain("@keyframes top-fade-in{to{opacity:1}}");
  });

  it("follows the page's scroll from beside it", () => {
    expect(declarationsOf(".page")).toContainEqual([
      "scroll-timeline",
      "--page block",
    ]);
    expect(declarationsOf(".panel")).toContainEqual([
      "timeline-scope",
      "--page",
    ]);
  });

  it("stays as a 24 px band where the scroll cannot drive it", () => {
    expect(
      declarationsOf(
        ".top-fade",
        "@supportsnot((animation-timeline:scroll())and(timeline-scope:--page))",
      ),
    ).toEqual(
      expect.arrayContaining([
        ["opacity", "1"],
        ["mask-size", "100% 24px"],
      ]),
    );
  });
});

describe("the frame's backing under the glass in the built CSS", () => {
  const backing = (covering: string) =>
    declarationsOf(
      `[data-platform=macos] .home-screen:has(>${covering}) .frame-under-glass`,
    );

  it("comes in under an overlay, on macOS only, as it opens", () => {
    expect(backing(".overlay[data-state=open]")).toEqual([["opacity", "1"]]);
  });

  it("keeps following the glass's fade where motion is reduced", () => {
    const reduced = rules.filter((rule) =>
      rule.media.includes("prefers-reduced-motion:reduce"),
    );
    const backingSelectors = [".frame", ".frame-under-glass"];

    expect(
      reduced
        .filter((rule) =>
          rule.selectors.some((selector) =>
            backingSelectors.includes(selector),
          ),
        )
        .flatMap((rule) => rule.declarations),
    ).not.toContain("transition:none");
    expect(declarationsOf(".frame-under-glass")).toContainEqual([
      "transition",
      "opacity .2s",
    ]);
  });

  it("comes in under a veil, on macOS only, on the veil's own delay", () => {
    const veil = declarationsOf(".veil").find(([property]) =>
      property!.startsWith("animation"),
    )![1]!;
    const transition = backing(".veil").find(
      ([property]) => property === "transition",
    )![1]!;
    const seconds = (value: string) => value.match(/[\d.]*\d+m?s/g);

    expect(backing(".veil")).toContainEqual(["opacity", "1"]);
    expect(seconds(transition)).toEqual(seconds(veil));
  });

  it("waits for the veil even when the screen first mounts under it", () => {
    expect(
      declarationsOf(
        "[data-platform=macos] .home-screen:has(>.veil) .frame-under-glass",
        "",
        true,
      ),
    ).toEqual([["opacity", "0"]]);
  });
});

// The declarations for `selector` outside any media query, in the order the
// build wrote them, from the rules under `supports`, by default none, and
// outside starting styles unless requested.
function declarationsOf(
  selector: string,
  supports = "",
  isStartingStyle = false,
) {
  return rules
    .filter(
      (rule) =>
        rule.selectors.includes(selector) &&
        rule.media === "" &&
        rule.supports === supports &&
        rule.isStartingStyle === isStartingStyle,
    )
    .flatMap((rule) =>
      rule.declarations.map((declaration) => {
        const colon = declaration.indexOf(":");
        return [
          declaration.slice(0, colon).trim(),
          normalise(declaration.slice(colon + 1)),
        ];
      }),
    );
}

// The animation an element gets where `media` applies, from the rules for
// `selectors`, least specific first, each overriding the ones before.
function animationOf(media: string, selectors: string[]): Animation {
  const animation = { ...initial };
  for (const selector of selectors) {
    for (const rule of rules) {
      if (
        !rule.selectors.includes(selector) ||
        (rule.media !== "" && !rule.media.includes(media))
      ) {
        continue;
      }
      for (const declaration of rule.declarations) {
        const colon = declaration.indexOf(":");
        const property = declaration.slice(0, colon).trim();
        const value = normalise(declaration.slice(colon + 1));
        const longhand = longhands.get(property);
        if (property === "animation") {
          Object.assign(animation, shorthand(value));
        } else if (longhand) {
          animation[longhand] = value;
        }
      }
    }
  }
  return animation;
}

// What an `animation` shorthand sets: everything it leaves out goes back
// to its initial value. The first time is the duration, a second the delay.
function shorthand(value: string): Animation {
  const animation = { ...initial };
  let times = 0;
  for (const token of value.match(/[^\s(]+(\([^)]*\))?/g) ?? []) {
    if (/^[\d.]+m?s$/.test(token)) {
      if (times++ === 0) animation.duration = token;
    } else if (token === "infinite" || /^[\d.]+$/.test(token)) {
      animation.iterationCount = token;
    } else if (timingKeywords.test(token)) {
      animation.timingFunction = token;
    } else if (!otherKeywords.test(token)) {
      animation.name = token;
    }
  }
  return animation;
}

// Values as the minifier writes them, whatever it does with spaces and
// leading zeros.
function normalise(value: string) {
  return value
    .trim()
    .replace(/\s*([(),])\s*/g, "$1")
    .replace(/\b0\./g, ".");
}

// The style rules of a flat, minified stylesheet, each with the media
// query it sits in. Keyframes are left out.
function styleRules(stylesheet: string): Rule[] {
  const found: Rule[] = [];
  const open: string[] = [];
  let start = 0;
  for (let i = 0; i < stylesheet.length; i++) {
    if (stylesheet[i] === "{") {
      // A statement such as `@layer a,b;` can come before a prelude.
      open.push(stylesheet.slice(start, i).split(";").at(-1)!.trim());
      start = i + 1;
    } else if (stylesheet[i] === "}") {
      const prelude = open.pop()!;
      const body = stylesheet.slice(start, i);
      start = i + 1;
      if (
        prelude.startsWith("@") ||
        open.some((at) => at.startsWith("@keyframes"))
      ) {
        continue;
      }
      const within = (kind: string) =>
        open
          .filter((at) => at.startsWith(kind))
          .join(" ")
          .replace(/\s/g, "");
      found.push({
        media: within("@media"),
        supports: within("@supports"),
        isStartingStyle: open.includes("@starting-style"),
        selectors: prelude.split(",").map((selector) => selector.trim()),
        declarations: body.split(";").filter(Boolean),
      });
    }
  }
  return found;
}
