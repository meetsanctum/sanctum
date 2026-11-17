import { describe, expect, it } from "vitest";

import { withoutKitRules } from "../tools/styles";

// A page's stylesheet without the utilities the kit's already has, rule by
// rule, inside the groups they're in, everything else as it was.

describe("a page's stylesheet", () => {
  const kit = [
    "@layer theme{:root{--spacing:.25rem}}",
    "@layer utilities{.m-0{margin:0}.mt-auto{margin-top:auto}",
    "@media (width>=40rem){.sm\\:flex{display:flex}}}",
  ].join("");

  it("keeps only the utilities the kit's doesn't have", () => {
    const page = [
      "/*! tailwindcss */@layer properties{*{--tw-leading:initial}}",
      "@layer theme{:root{--spacing:.25rem}}",
      "@layer utilities{.m-0{margin:0}.mt-7{margin-top:1.75rem}",
      "@media (width>=40rem){.sm\\:flex{display:flex}.sm\\:grid{display:grid}}",
      "@media (width>=64rem){.lg\\:flex{display:flex}}}",
    ].join("");
    expect(withoutKitRules(page, kit)).toBe(
      [
        "/*! tailwindcss */@layer properties{*{--tw-leading:initial}}",
        "@layer theme{:root{--spacing:.25rem}}",
        "@layer utilities{.mt-7{margin-top:1.75rem}",
        "@media (width>=40rem){.sm\\:grid{display:grid}}",
        "@media (width>=64rem){.lg\\:flex{display:flex}}}",
      ].join(""),
    );
  });

  it("leaves out a group, or the layer, that ends up empty", () => {
    expect(
      withoutKitRules(
        "@layer utilities{.m-0{margin:0}@media (width>=40rem){.sm\\:flex{display:flex}}}",
        kit,
      ),
    ).toBe("");
  });

  it("puts a page's own utility after the kit's, whatever Tailwind's order", () => {
    // The trade-off it makes: `mt-auto` is the kit's, so on an element
    // with both, the page's margin comes later and wins.
    const page =
      "@layer utilities{.m-\\[13px\\]{margin:13px}.mt-auto{margin-top:auto}}";
    expect(withoutKitRules(page, kit)).toBe(
      "@layer utilities{.m-\\[13px\\]{margin:13px}}",
    );
  });

  it("keeps a rule the kit has only in another group, or with other values", () => {
    const page =
      "@layer utilities{.sm\\:flex{display:flex}.mt-auto{margin-top:auto!important}}";
    expect(withoutKitRules(page, kit)).toBe(page);
  });

  it("keeps a layer without a name, which is never the kit's", () => {
    const page = "@layer utilities{@layer{.m-0{margin:0}}.m-0{margin:0}}";
    expect(
      withoutKitRules(page, "@layer utilities{@layer{.m-0{margin:0}}}"),
    ).toBe(page);
    expect(withoutKitRules(page, kit)).toBe(
      "@layer utilities{@layer{.m-0{margin:0}}}",
    );
  });

  it("reads braces in strings and escapes as text", () => {
    const page =
      '@layer utilities{.content-\\[\\"\\}\\"\\]{content:"}"}.m-0{margin:0}}';
    expect(withoutKitRules(page, kit)).toBe(
      '@layer utilities{.content-\\[\\"\\}\\"\\]{content:"}"}}',
    );
  });
});
