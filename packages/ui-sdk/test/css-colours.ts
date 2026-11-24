import { isTokenHash, tokenize } from "@csstools/css-tokenizer";
import { parse } from "postcss";

// Look at declaration values so selectors, quoted text and URLs can contain
// hashes without being mistaken for colours.
export function hexAlphaColours(css: string): string[] {
  const colours: string[] = [];
  parse(css).walkDecls(({ prop, value }) => {
    for (const token of tokenize({ css: value })) {
      if (
        isTokenHash(token) &&
        /^(?:[\da-f]{4}|[\da-f]{8})$/i.test(token[4].value)
      ) {
        colours.push(`${prop}: ${token[1]}`);
      }
    }
  });
  return colours;
}
