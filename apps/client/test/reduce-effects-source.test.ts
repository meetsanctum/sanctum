import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every part that blurs, masks or casts a soft shadow has its look under
// Reduce effects, read from the shell's and ui-sdk's sources: a class with
// its `reduce-effects:` partner in the same class string, a CSS rule with a
// [data-effects="reduced"] rule for the same element, and a script that
// draws one with useReducedEffects. Live blur goes only through `frosted`,
// the one utility allowed to declare it. A hairline or a ring with no blur
// is not a soft shadow.

const root = fileURLToPath(new URL("../../..", import.meta.url));
const sources = ["apps/client/src", "packages/ui-sdk/src"];

function filesIn(dir: string, kinds: RegExp): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((path) => kinds.test(path))
    .map((path) => join(dir, path));
}

const read = (path: string) => readFileSync(join(root, path), "utf8");

// A shadow's parts that are soft: not inset, with a blur above 0.
function hasSoftShadow(value: string) {
  return value
    .split(/,(?![^(]*\))/)
    .map((part) => part.trim().replaceAll("_", " "))
    .some((part) => {
      if (part.startsWith("inset") || part === "none") return false;
      const lengths = part.match(/-?[\d.]+(?:px|rem)?(?=\s|$)/g) ?? [];
      return lengths.length >= 3 && Number.parseFloat(lengths[2]!) > 0;
    });
}

type Effect = "shadow" | "drop-shadow" | "mask" | "blur";

// The effect a class draws, if any, and the variants it is under.
function effectOf(name: string): { effect: Effect; prefix: string } | null {
  const prefix = name.slice(0, findBase(name) + 1);
  const base = name.slice(prefix.length);
  if (prefix.includes("reduce-effects:")) return null;
  if (/^shadow-(xs|sm|md|lg|xl|2xl)$/.test(base))
    return { effect: "shadow", prefix };
  const custom = /^shadow-\[(.*)\]$/.exec(base);
  if (custom && hasSoftShadow(custom[1]!)) return { effect: "shadow", prefix };
  if (/^drop-shadow-(?!none$)/.test(base))
    return { effect: "drop-shadow", prefix };
  if (/^\[mask-image:(?!none\])/.test(base)) return { effect: "mask", prefix };
  if (
    /^backdrop-blur(?!-none$)/.test(base) ||
    /^\[backdrop-filter:(?!none\])/.test(base)
  ) {
    return { effect: "blur", prefix };
  }
  return null;
}

// Where a class's variants end: the last ':' outside its brackets.
function findBase(name: string) {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) last = i;
  }
  return last;
}

const undoes: Record<Exclude<Effect, "blur">, RegExp> = {
  shadow: /^shadow-/,
  "drop-shadow": /^drop-shadow-none$/,
  mask: /^\[mask-image:none\]$/,
};

function classStringProblems(path: string, text: string) {
  const problems: string[] = [];
  for (const [, literal] of text.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
    const names = literal!.split(/\s+/).filter(Boolean);
    for (const name of names) {
      const found = effectOf(name);
      if (!found) continue;
      if (found.effect === "blur") {
        problems.push(`${path}: ${name} (live blur goes through frosted)`);
        continue;
      }
      const partner = names.some((each) => {
        if (!each.startsWith("reduce-effects:")) return false;
        const rest = each.slice("reduce-effects:".length);
        return (
          rest.startsWith(found.prefix) &&
          undoes[found.effect as Exclude<Effect, "blur">].test(
            rest.slice(found.prefix.length),
          )
        );
      });
      if (!partner) problems.push(`${path}: ${name}`);
    }
  }
  return problems;
}

type CssRule = { selector: string; body: string; within: string[] };

function cssRules(text: string): CssRule[] {
  const rules: CssRule[] = [];
  const open: string[] = [];
  let start = 0;
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === "{") {
      open.push(clean.slice(start, i).split(";").at(-1)!.trim());
      start = i + 1;
    } else if (clean[i] === "}") {
      const selector = open.pop() ?? "";
      const body = clean.slice(start, i);
      start = i + 1;
      if (!selector.startsWith("@")) {
        rules.push({ selector, body, within: [...open] });
      }
    }
  }
  return rules;
}

function drawsEffect(body: string) {
  for (const declaration of body.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (property === "box-shadow" && hasSoftShadow(value)) return property;
    if (/^(-webkit-)?mask-image$/.test(property) && value !== "none") {
      return property;
    }
    if (/^(-webkit-)?backdrop-filter$/.test(property) && value !== "none") {
      return property;
    }
    if (property === "filter" && /blur|drop-shadow/.test(value)) {
      return property;
    }
  }
  return null;
}

function cssProblems(path: string, text: string) {
  const rules = cssRules(text);
  const reduced = rules.filter((rule) =>
    /data-effects=["']?reduced/.test(rule.selector),
  );
  const problems: string[] = [];
  for (const rule of rules) {
    if (rule.within.some((at) => at.startsWith("@utility frosted"))) continue;
    if (/data-effects=["']?reduced/.test(rule.selector)) continue;
    const property = drawsEffect(rule.body);
    if (!property) continue;
    const element = rule.selector.match(/\.[\w-]+(?![\s\S]*\.[\w-])/)?.[0];
    const partner =
      element !== undefined &&
      reduced.some((each) => each.selector.includes(element));
    if (!partner) problems.push(`${path}: ${rule.selector} { ${property} }`);
  }
  return problems;
}

describe("every effect's look under Reduce effects", () => {
  const scripts = sources.flatMap((dir) => filesIn(dir, /\.tsx?$/));
  const sheets = sources.flatMap((dir) => filesIn(dir, /\.css$/));

  it("has a reduce-effects: partner in each class string", () => {
    expect(
      scripts.flatMap((path) => classStringProblems(path, read(path))),
    ).toEqual([]);
  });

  it("has a [data-effects=reduced] rule for each CSS rule that draws one", () => {
    expect(sheets.flatMap((path) => cssProblems(path, read(path)))).toEqual([]);
  });

  it("reads Reduce effects where a script draws one", () => {
    const drawing = scripts.filter((path) =>
      /\.style\.(webkitMaskImage|maskImage|backdropFilter|filter)\s*=/.test(
        read(path),
      ),
    );
    expect(drawing.length).toBeGreaterThan(0);
    expect(
      drawing.filter((path) => !read(path).includes("useReducedEffects")),
    ).toEqual([]);
  });

  it("finds what it looks for", () => {
    // The checks above pass on nothing if they find nothing to check.
    expect(classStringProblems("example", '"shadow-md p-4"')).toEqual([
      "example: shadow-md",
    ]);
    expect(
      classStringProblems(
        "example",
        '"data-[on]:shadow-[0_1px_3px_rgb(0_0_0/12%)] reduce-effects:data-[on]:shadow-none"',
      ),
    ).toEqual([]);
    expect(
      classStringProblems(
        "example",
        '"shadow-[0_0_0_2px_red] shadow-[inset_0_0_0_1px_red]"',
      ),
    ).toEqual([]);
    expect(
      cssProblems("example", ".card { box-shadow: 0 8px 24px black; }"),
    ).toEqual(["example: .card { box-shadow }"]);
    expect(
      cssProblems(
        "example",
        '.card { box-shadow: 0 8px 24px black; } [data-effects="reduced"] .card { box-shadow: none; }',
      ),
    ).toEqual([]);
  });
});
