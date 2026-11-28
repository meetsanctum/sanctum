import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "postcss";

const theme = parse(
  readFileSync(join(import.meta.dirname, "../src/theme.css"), "utf8"),
);

export function themeTokens(mode: string) {
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

export function themeRgb(
  tokens: ReadonlyMap<string, string>,
  token: string,
): number[] {
  const value = tokens.get(token);
  const alias = /^var\((--[\w-]+)\)$/.exec(value ?? "")?.[1];
  if (alias) return themeRgb(tokens, alias);

  const rgb = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value ?? "");
  if (!rgb)
    throw new Error(`Expected an RGB hex colour for ${token}, got ${value}`);
  return rgb.slice(1).map((hex) => Number.parseInt(hex, 16));
}

function luminance(rgb: readonly number[]) {
  const weights = [0.2126, 0.7152, 0.0722];
  return rgb.reduce((total, component, index) => {
    const channel = component / 255;
    const linear =
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return total + linear * weights[index]!;
  }, 0);
}

export function contrast(foreground: number[], background: number[]) {
  const text = luminance(foreground);
  const surface = luminance(background);
  return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
}
