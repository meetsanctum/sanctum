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

function shadowParts(value: string) {
  return value.split(/,(?![^(]*\))/).map((part) => {
    const tokens: string[] =
      part.replaceAll("_", " ").match(/[\w-]+\([^)]*\)|\S+/g) ?? [];
    const lengths = tokens.filter((token) =>
      /^-?(?:\d*\.)?\d+(?:[a-z]+)?$/.test(token),
    );
    return { tokens, lengths };
  });
}

// A shadow's parts that are soft: not inset, with a blur above 0.
function hasSoftShadow(value: string) {
  return shadowParts(value).some(
    ({ tokens, lengths }) =>
      !tokens.includes("inset") && Number.parseFloat(lengths[2] ?? "0") > 0,
  );
}

// A reduced shadow must set its offsets and leave its blur at zero.
function isHardShadow(value: string) {
  return (
    value === "none" ||
    shadowParts(value).every(
      ({ tokens, lengths }) =>
        lengths.length >= 2 &&
        Number.parseFloat(lengths[2] ?? "0") === 0 &&
        (lengths.length === 4 ||
          !tokens.some((token) => /^(var|calc|min|max|clamp)\(/.test(token))),
    )
  );
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

function undoes(effect: Exclude<Effect, "blur">, name: string) {
  if (effect === "drop-shadow") return name === "drop-shadow-none";
  if (effect === "mask") return name === "[mask-image:none]";
  const custom = /^shadow-\[(.*)\]$/.exec(name);
  return name === "shadow-none" || (custom && isHardShadow(custom[1]!));
}

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
      const { effect, prefix } = found;
      const reducedPrefix = `reduce-effects:${prefix}`;
      const partner = names.some((each) => {
        return (
          each.startsWith(reducedPrefix) &&
          undoes(effect, each.slice(reducedPrefix.length))
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

function declarations(body: string) {
  const values = new Map<string, string>();
  for (const declaration of body.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    values.set(property, value);
  }
  return values;
}

function drawsEffect(property: string, value: string) {
  if (property === "box-shadow") return hasSoftShadow(value);
  if (/^(?:-webkit-)?(?:mask-image|backdrop-filter)$/.test(property)) {
    return value !== "none";
  }
  return property === "filter" && /blur|drop-shadow/.test(value);
}

function cssProblems(path: string, text: string) {
  const rules = cssRules(text);
  const reducedPrefix = /^\[data-effects=(?:"reduced"|'reduced'|reduced)\]\s+/;
  const reduced = rules
    .filter((rule) => reducedPrefix.test(rule.selector))
    .map((rule) => ({
      selector: rule.selector.replace(reducedPrefix, "").replace(/\s+/g, " "),
      within: rule.within,
      values: declarations(rule.body),
    }));
  const problems: string[] = [];
  for (const rule of rules) {
    if (rule.within.some((at) => at.startsWith("@utility frosted"))) continue;
    if (reducedPrefix.test(rule.selector)) continue;
    const selector = rule.selector.replace(/\s+/g, " ");
    for (const [property, value] of declarations(rule.body)) {
      if (!drawsEffect(property, value)) continue;
      const partner = reduced.some((each) => {
        if (each.selector !== selector) return false;
        if (!each.within.every((at, index) => at === rule.within[index])) {
          return false;
        }
        const override = each.values.get(property);
        return (
          override !== undefined &&
          (property === "box-shadow"
            ? isHardShadow(override)
            : override === "none")
        );
      });
      if (!partner) problems.push(`${path}: ${rule.selector} { ${property} }`);
    }
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

  it("reads Reduce effects where SVG masks have styled shapes", () => {
    const masked = scripts.filter((path) =>
      /<mask\b[^>]*>(?:(?!<\/mask>)[\s\S])*?\bclassName=/.test(read(path)),
    );
    expect(masked.length).toBeGreaterThan(0);
    expect(
      masked.filter((path) => !read(path).includes("useReducedEffects")),
    ).toEqual([]);
  });

  it.each([
    "shadow-[0_16px_40px_rgb(0_0_0/24%)]",
    "shadow-sm",
    "shadow-red-500",
  ])("rejects %s as a reduced shadow override", (override) => {
    const shadow = "shadow-[0_16px_40px_rgb(0_0_0/24%)]";
    expect(
      classStringProblems("example", `"${shadow} reduce-effects:${override}"`),
    ).toEqual([`example: ${shadow}`]);
  });

  it("accepts a reduced shadow with only hairlines", () => {
    expect(
      classStringProblems(
        "example",
        '"shadow-md reduce-effects:shadow-[inset_0_1px_0_white,0_0_0_1px_black]"',
      ),
    ).toEqual([]);
  });

  it.each([
    ".card { opacity: 1; }",
    ".card { mask-image: linear-gradient(black, transparent); }",
    ".card-title { mask-image: none; }",
    ".card .title { mask-image: none; }",
  ])("rejects a CSS override that leaves the mask active: %s", (override) => {
    expect(
      cssProblems(
        "example",
        `.card { mask-image: linear-gradient(black, transparent); } [data-effects="reduced"] ${override}`,
      ),
    ).toEqual(["example: .card { mask-image }"]);
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
