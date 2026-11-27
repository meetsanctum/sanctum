import { readFileSync } from "node:fs";
import { parse } from "postcss";
import { expect, it } from "vitest";

const theme = parse(
  readFileSync(new URL("../src/theme.css", import.meta.url), "utf8"),
);

function themeTokens(mode: string) {
  const tokens = new Map<string, string>();
  const selectors = [":root", `[data-mode="${mode}"]`, "[data-mode]"];
  theme.walkDecls(/^--/, ({ parent, prop, value }) => {
    if (
      (parent?.type === "rule" &&
        parent.selectors.some((selector) => selectors.includes(selector))) ||
      (parent?.type === "atrule" && parent.name === "theme")
    ) {
      tokens.set(prop, value);
    }
  });
  return tokens;
}

function luminance(tokens: ReadonlyMap<string, string>, token: string): number {
  const value = tokens.get(token);
  const alias = /^var\((--[\w-]+)\)$/.exec(value ?? "")?.[1];
  if (alias) return luminance(tokens, alias);

  const rgb = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value ?? "");
  if (!rgb)
    throw new Error(`Expected an RGB hex colour for ${token}, got ${value}`);
  const [red, green, blue] = rgb.slice(1).map((hex) => {
    const channel = Number.parseInt(hex, 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

it.each(["day", "evening"])(
  "keeps problem text at 4.5:1 contrast on a card in %s mode",
  (mode) => {
    const tokens = themeTokens(mode);
    const text = luminance(tokens, "--color-destructive");
    const card = luminance(tokens, "--color-card");
    const contrast =
      (Math.max(text, card) + 0.05) / (Math.min(text, card) + 0.05);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  },
);
