import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { frameBridge } from "../src/frame/protocol";
import { digestOf, listFiles } from "../tools/files";
import { lucideIcons } from "../tools/icons";
import { buildKit, sdkVersion, type KitManifest } from "../tools/kit";
import { hexAlphaColours } from "./css-colours";

// The kit, React and ui-sdk as the modules every app page imports, in parts:
// React, ui-sdk without its icons or charts, its charts, and one module per
// icon.

let dir: string;
let kit: KitManifest;
const read = (path: string) => readFileSync(join(dir, path), "utf8");
// The kit's own modules a module imports.
const importsOf = (path: string) =>
  [...read(path).matchAll(/from"(\.\.?\/[^"]+)"/g)].map(([, from]) =>
    join(path, "..", from!),
  );

// What a module loads, through what it loads.
const reached = (from: string) => {
  const found = new Set<string>();
  const reach = (path: string) => {
    for (const next of importsOf(path)) {
      if (!found.has(next)) {
        found.add(next);
        reach(next);
      }
    }
  };
  reach(from);
  return found;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sanctum-kit-"));
  kit = await buildKit(dir);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Hashing its 2,000 files takes a while on a busy machine.
describe("the kit", { timeout: 60_000 }, () => {
  it("says its version, bridge, digest, stylesheet and which module answers each import", async () => {
    expect(kit).toEqual({
      version: sdkVersion(),
      bridge: frameBridge,
      // What the build says it wrote is what's on disk.
      digest: digestOf(await listFiles(dir, ["kit.json"])),
      stylesheet: "kit.css",
      imports: {
        react: "react.js",
        "react/jsx-runtime": "react-jsx-runtime.js",
        "react-dom": "react-dom.js",
        "react-dom/client": "react-dom-client.js",
        "@meetsanctum/ui-sdk": "ui-sdk.js",
        "@meetsanctum/ui-sdk/charts": "charts.js",
        "@meetsanctum/ui-sdk/icons/": "icons/",
      },
    });
    expect(JSON.parse(read("kit.json"))).toEqual(kit);
    expect(kit.bridge).toBe(4);
    for (const [, module] of Object.entries(kit.imports)) {
      expect(existsSync(join(dir, module))).toBe(true);
    }
  });

  it("has one module per icon, each small, and keeps them out of ui-sdk's", () => {
    const files = new Set(lucideIcons().values());
    expect(readdirSync(join(dir, "icons")).sort()).toEqual(
      [...files].map((file) => `${file}.js`).sort(),
    );
    expect(statSync(join(dir, "icons/check.js")).size).toBeLessThan(200);
    // Lucide's 1,900 icons alone are 750 KB.
    expect(statSync(join(dir, "ui-sdk.js")).size).toBeLessThan(400_000);
    // An icon ui-sdk's own components don't use.
    expect(read("icons/bitcoin.js")).toBeTruthy();
    expect(read("ui-sdk.js")).not.toContain("bitcoin");
  });

  it("has the charts in a module of their own, small, which ui-sdk's leaves out", () => {
    // The charts are about 16 KB.
    expect(statSync(join(dir, "charts.js")).size).toBeLessThan(40_000);
    expect(read("charts.js")).toContain("over the last 24 hours");
    expect(read("ui-sdk.js")).not.toContain("over the last 24 hours");
    expect(importsOf("ui-sdk.js")).not.toContain("charts.js");
  });

  it("gives the charts the home clock without zod, which ui-sdk's validation needs", () => {
    const charts = ["charts.js", ...reached("charts.js")];
    // zod's own words for a value of the wrong type.
    expect(charts.some((path) => read(path).includes("invalid_type"))).toBe(
      false,
    );
    // The clock, in a module the charts and ui-sdk's both load, so a page's
    // charts and widget cards read the one home clock its frame sets.
    const [clock] = [...reached("charts.js")].filter((path) =>
      read(path).includes("formatToParts"),
    );
    expect(clock).toBeDefined();
    expect(importsOf("charts.js")).toContain(clock);
    expect(importsOf("ui-sdk.js")).toContain(clock);
  });

  it("exports each public chart from the built module an app imports", async () => {
    const charts = await import(pathToFileURL(join(dir, "charts.js")).href);
    expect(Object.keys(charts).sort()).toEqual([
      "DayBandChart",
      "DayBandMarks",
      "DayStripChart",
      "DayTimeAxis",
      "LineChart",
      "WeekColumnsChart",
      "WeekRangeChart",
    ]);
  });

  it("gives a frame one React, which all its modules share", () => {
    const [react] = importsOf("react.js").filter((path) =>
      path.includes("chunks/react-"),
    );
    expect(react).toBeDefined();
    expect(reached("react-dom-client.js")).toContain(react);
    expect(importsOf("ui-sdk.js")).toContain(react);
    expect(importsOf("charts.js")).toContain(react);
    // An icon, through Lucide's shared code.
    expect(reached("icons/check.js")).toContain(react);
    // And one React DOM: the root ui-sdk starts a frame's page with is the
    // one pages import.
    const [client] = importsOf("react-dom-client.js").filter((path) =>
      path.startsWith("chunks/client-"),
    );
    expect(client).toBeDefined();
    expect(importsOf("ui-sdk.js")).toContain(client);
  });

  it("has a stylesheet with Sanctum's theme and ui-sdk's classes, and Inter as WOFF2 next to it", () => {
    const css = read("kit.css");
    expect(css).toContain("--carbon:#222326");
    expect(css).toContain("--cell:64px");
    expect(css).toMatch(/\[data-mode=evening\]/);
    expect(css).toMatch(
      /url\(\.\/assets\/inter-latin-400-normal-[\w-]+\.woff2\)/,
    );
    expect(css).not.toMatch(/\.woff\)/);
    expect(css).not.toMatch(/url\(\//);
    const fonts = readdirSync(join(dir, "assets"));
    expect(fonts.every((name) => name.endsWith(".woff2"))).toBe(true);
  });

  it("turns off frosted blur on app pages in the frame", () => {
    expect(read("kit.css")).toMatch(
      /\.frame-page \.frosted[^{}]*\{-webkit-backdrop-filter:none;backdrop-filter:none\}/,
    );
  });

  it("writes colours with alpha as rgba() or transparent, never as hex", () => {
    // The Shelly Wall Display's web view drops `#0000` and `#ffffff24`.
    const css = read("kit.css");
    expect(hexAlphaColours(css)).toEqual([]);
    expect(css).toContain(".border-transparent{border-color:transparent}");
    expect(css).toMatch(
      /[{;]--hairline-on-carbon:rgba\(255,255,255,\.14\)[;}]/,
    );
  });

  it("spans widgets across the phone tile grid and keeps their own span in other grids", () => {
    const css = read("kit.css");
    expect(css).toMatch(
      /@media[^{}]*40rem[^{}]*\{\.tile-grid\{grid-template-columns:repeat\(6,minmax\(0,1fr\)\)\}\.tile-grid>\[data-slot=widget-card\]\{grid-column:1\/-1\}\}/,
    );
    expect(css).toContain(
      "grid-column:span var(--widget-columns) / span var(--widget-columns)",
    );
  });

  it("comes out the same from the same sources", async () => {
    const again = await mkdtemp(join(tmpdir(), "sanctum-kit-"));
    try {
      expect((await buildKit(again)).digest).toBe(kit.digest);
    } finally {
      await rm(again, { recursive: true, force: true });
    }
  }, 120_000);
});
