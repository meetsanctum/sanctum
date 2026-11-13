import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { knotPath as clientKnot } from "../../client/src/knot.ts";
import {
  dmgIconSize,
  dmgIcons,
  dmgWindow,
  iconSizes,
  iconSvg,
  knotGrid,
  knotPath,
  lockups,
  tileKnotUnit,
} from "../scripts/artwork.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const brand = join(root, "assets", "brand");
const read = (...path: string[]) => readFileSync(join(...path), "utf8");
const paths = (svg: string) =>
  [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
const numbers = (path: string) => path.match(/-?[\d.]+/g)!.map(Number);

describe("the knot", () => {
  it("is the same everywhere it is drawn", () => {
    const knot = knotPath();
    expect(paths(read(brand, "sanctum-mark.svg"))).toEqual([knot]);
    expect(paths(read(brand, "sanctum-mark-white.svg"))).toEqual([knot]);
    expect(clientKnot).toBe(knot);
    expect(
      paths(read(root, "apps", "website", "src", "app", "knot.tsx")),
    ).toEqual([knot]);
    expect(paths(read(brand, "sanctum-favicon.svg"))).toEqual([
      knotPath(1, 1, 1),
    ]);
    for (const { name, knot: box } of lockups) {
      for (const file of [`${name}.svg`, `${name}-white.svg`]) {
        expect(paths(read(brand, file))[0]).toBe(
          knotPath(box.size / knotGrid, box.x, box.y),
        );
      }
    }
  });

  it("lands on whole units, and whole pixels at a whole number of them", () => {
    for (const unit of [1, 2, 4]) {
      for (const value of numbers(knotPath(unit))) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
    for (const value of numbers(knotPath())) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(knotGrid);
    }
  });
});

describe("iconSizes", () => {
  it("puts the knot on each image as on any tile, centred on whole pixels", () => {
    for (const icon of iconSizes) {
      const { size, at, width } = icon;
      expect(at * 2 + width).toBe(size);
      const unit = tileKnotUnit(width);
      expect(Number.isInteger(unit)).toBe(true);
      const knotAt = (size - knotGrid * unit) / 2;
      expect(Number.isInteger(knotAt)).toBe(true);
      expect(paths(iconSvg(icon, "Sanctum"))[1]).toBe(
        knotPath(unit, knotAt, knotAt),
      );
    }
  });

  it("draws the 128 px knot 4 px to a unit, for macOS to shrink to 32 and 16", () => {
    const icon = iconSizes.find(({ size }) => size === 128)!;
    expect(tileKnotUnit(icon.width)).toBe(4);
    expect(paths(iconSvg(icon, "Sanctum"))[1]).toBe(knotPath(4, 36, 36));
  });
});

describe("the disk image's window", () => {
  it("keeps both icons inside it", () => {
    for (const { x, y } of Object.values(dmgIcons)) {
      expect(x - dmgIconSize / 2).toBeGreaterThan(0);
      expect(x + dmgIconSize / 2).toBeLessThan(dmgWindow.width);
      expect(y + dmgIconSize / 2).toBeLessThan(dmgWindow.height);
    }
  });
});
