// Draws the brand's files in assets/brand, the desktop app's icon among them,
// and the disk image's background from artwork.ts, on macOS:
// `pnpm --filter @meetsanctum/desktop artwork`. Everything it writes is
// committed, so packaging and builds need none of this.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { productName } from "../../client/src/brand.ts";
import {
  carbon,
  dmgBackgroundSvg,
  dmgWindow,
  faviconSvg,
  iconSizes,
  iconSvg,
  knotGrid,
  knotPath,
  lockups,
  markSvg,
  tileKnotUnit,
  white,
  withKnot,
} from "./artwork.ts";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const resources = join(desktop, "resources");
const brand = join(desktop, "..", "..", "assets", "brand");
const work = mkdtempSync(join(tmpdir(), "sanctum-artwork-"));

// Which images of the .icns each size fills.
const iconsetNames: Record<number, string[]> = {
  64: ["icon_32x32@2x"],
  128: ["icon_128x128"],
  256: ["icon_128x128@2x", "icon_256x256"],
  512: ["icon_256x256@2x", "icon_512x512"],
  1024: ["icon_512x512@2x"],
};

// Square art for a PNG: `body` drawn on a canvas `size` px across.
const square = (size: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${body}</svg>`;

try {
  // Each job: an SVG and the PNG to draw it as.
  const jobs: string[] = [];
  const draw = (
    name: string,
    svg: string,
    width: number,
    height: number,
    out: string,
  ) => {
    const file = join(work, `${name}.svg`);
    writeFileSync(file, svg);
    jobs.push(file, `${width}`, `${height}`, out);
  };

  // The mark, alone and as the favicon.
  writeFileSync(
    join(brand, "sanctum-mark.svg"),
    markSvg(carbon, `${productName} mark`, `${productName} mark`),
  );
  writeFileSync(
    join(brand, "sanctum-mark-white.svg"),
    markSvg(white, `${productName} mark, in White`, `${productName} mark`),
  );
  writeFileSync(join(brand, "sanctum-favicon.svg"), faviconSvg());

  // The knot at 80% of a 1024 px square, and the square app icon with the
  // knot on Carbon as on any tile.
  const markUnit = Math.floor((1024 * 0.8) / knotGrid);
  const markAt = (1024 - knotGrid * markUnit) / 2;
  for (const [ink, file] of [
    [carbon, "sanctum-mark.png"],
    [white, "sanctum-mark-white.png"],
  ] as const) {
    draw(
      file,
      square(
        1024,
        `<path fill="${ink}" d="${knotPath(markUnit, markAt, markAt)}"/>`,
      ),
      1024,
      1024,
      join(brand, file),
    );
  }
  const tileUnit = tileKnotUnit(1024);
  const tileAt = (1024 - knotGrid * tileUnit) / 2;
  draw(
    "app-icon",
    square(
      1024,
      `<rect width="1024" height="1024" fill="${carbon}"/><path fill="${white}" d="${knotPath(tileUnit, tileAt, tileAt)}"/>`,
    ),
    1024,
    1024,
    join(brand, "sanctum-app-icon.png"),
  );

  // The lockups, in Carbon and in White, and their PNGs.
  for (const { name, knot, pngHeight } of lockups) {
    for (const [suffix, pngSuffix] of [
      ["", "-carbon"],
      ["-white", "-white"],
    ] as const) {
      const file = join(brand, `${name}${suffix}.svg`);
      const svg = withKnot(readFileSync(file, "utf8"), knot);
      writeFileSync(file, svg);
      const [, , width, height] = svg
        .match(/viewBox="([^"]+)"/)![1]!
        .split(" ")
        .map(Number) as [number, number, number, number];
      const scale = pngHeight / height;
      const pad = 4 / scale;
      const padded = svg
        .replace(
          /viewBox="[^"]+"/,
          `viewBox="${-pad} ${-pad} ${width + 2 * pad} ${height + 2 * pad}"`,
        )
        .replace(/ width="[^"]+" height="[^"]+"/, "");
      draw(
        `${name}${pngSuffix}`,
        padded,
        Math.round(width * scale + 8),
        pngHeight + 8,
        join(brand, `${name}${pngSuffix}.png`),
      );
    }
  }

  // The desktop app's icon and the master beside the brand's other files.
  const iconset = join(work, "icon.iconset");
  mkdirSync(iconset);
  for (const icon of iconSizes) {
    for (const name of iconsetNames[icon.size] ?? []) {
      draw(
        `icon-${icon.size}`,
        iconSvg(icon, `${productName} app icon`),
        icon.size,
        icon.size,
        join(iconset, `${name}.png`),
      );
    }
  }
  const master = iconSizes.find((icon) => icon.size === 1024)!;
  writeFileSync(
    join(brand, "sanctum-macos-icon.svg"),
    iconSvg(master, `${productName} app icon`),
  );

  // The disk image's background, at 1× and 2×.
  const { width, height } = dmgWindow;
  draw(
    "background",
    dmgBackgroundSvg(),
    width,
    height,
    join(work, "background.png"),
  );
  draw(
    "background",
    dmgBackgroundSvg(),
    width * 2,
    height * 2,
    join(work, "background@2x.png"),
  );

  execFileSync(
    "swift",
    [join(desktop, "scripts", "rasterise.swift"), ...jobs],
    {
      stdio: "inherit",
    },
  );
  mkdirSync(resources, { recursive: true });
  execFileSync("iconutil", [
    "-c",
    "icns",
    iconset,
    "-o",
    join(brand, "sanctum-macos-icon.icns"),
  ]);
  execFileSync("tiffutil", [
    "-cathidpicheck",
    join(work, "background.png"),
    join(work, "background@2x.png"),
    "-out",
    join(resources, "dmg-background.tiff"),
  ]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
