// The brand's artwork, which `pnpm --filter @meetsanctum/desktop artwork`
// writes (artwork-files.ts): the knot and the files in assets/brand, the
// desktop app's icon in the macOS icon shape and the disk image's window
// (assets/brand/README.md, Construction).

const round = (value: number) => +value.toFixed(3);
const points = (...values: number[]) => values.map(round).join(" ");

// The knot on its 14-unit grid: two stadium loops, each 6 units wide with
// 2-unit bands around a 2-unit opening, crossing 4 units from each end. Each
// band passes under the other loop's once, cut 1 unit short on each side.
// `unit` is the size of a unit and (`x`, `y`) the grid's corner; at a whole
// number of pixels per unit, every edge lands on a pixel.
export const knotGrid = 14;

export function knotPath(unit = 1, x = 0, y = 0) {
  const at = (...values: number[]) =>
    points(...values.map((value, index) => value * unit + (index % 2 ? y : x)));
  const radius = (value: number) => points(value * unit, value * unit);
  // Each cut ends where its loop's curve begins.
  return [
    // The upright loop's lower half, from under the top band.
    `M${at(6, 11)}A${radius(1)} 0 0 0 ${at(8, 11)}L${at(10, 11)}A${radius(3)} 0 0 1 ${at(4, 11)}L${at(4, 7)}L${at(6, 7)}Z`,
    // The lying loop's left half, from under the right band.
    `M${at(7, 6)}L${at(3, 6)}A${radius(1)} 0 0 0 ${at(3, 8)}L${at(3, 10)}A${radius(3)} 0 0 1 ${at(3, 4)}L${at(7, 4)}Z`,
    // The lying loop's right half, from under the left band.
    `M${at(11, 10)}L${at(7, 10)}L${at(7, 8)}L${at(11, 8)}A${radius(1)} 0 0 0 ${at(11, 6)}L${at(11, 4)}A${radius(3)} 0 0 1 ${at(11, 10)}Z`,
    // The upright loop's upper half, from under the bottom band.
    `M${at(10, 3)}L${at(10, 7)}L${at(8, 7)}L${at(8, 3)}A${radius(1)} 0 0 0 ${at(6, 3)}L${at(4, 3)}A${radius(3)} 0 0 1 ${at(10, 3)}Z`,
  ].join("");
}

// The knot on a tile, such as an app icon: 14 units of a tile 26 units
// across, so 6 units of margin each side, in whole pixels per unit.
export function tileKnotUnit(tile: number) {
  return Math.round(tile / 26);
}

// The mark: the knot alone on its grid, in the ink given, which inlined
// copies change through the CSS `color`.
export function markSvg(color: string, title: string, label: string) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${knotGrid} ${knotGrid}" width="280" height="280" color="${color}" role="img" aria-label="${label}">`,
    `  <title>${title}</title>`,
    `  <path fill="currentColor" d="${knotPath()}"/>`,
    `</svg>`,
    "",
  ].join("\n");
}

// The favicon: the knot one unit to a pixel inside a 16 px square, in Carbon,
// or White where the browser is dark.
export function faviconSvg() {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">`,
    `  <style>path{fill:${carbon}}@media (prefers-color-scheme:dark){path{fill:${white}}}</style>`,
    `  <path d="${knotPath(1, 1, 1)}"/>`,
    `</svg>`,
    "",
  ].join("\n");
}

// The lockups keep their wordmarks (outlined from Inter Medium) and the
// knot's square: a corner and a size, in the file's own units. Their PNGs
// are `pngHeight` px tall with 4 px more around.
export const lockups = [
  { name: "sanctum-logo", knot: { x: 0, y: 0, size: 92.4 }, pngHeight: 240 },
  {
    name: "sanctum-logo-stacked",
    knot: { x: 110.09, y: 0, size: 167.33 },
    pngHeight: 640,
  },
];

// A lockup file with its knot, the first path, drawn anew.
export function withKnot(
  lockup: string,
  knot: { x: number; y: number; size: number },
) {
  return lockup.replace(
    /<path fill="currentColor"[^>]*\/>/,
    `<path fill="currentColor" d="${knotPath(knot.size / knotGrid, knot.x, knot.y)}"/>`,
  );
}

// One corner of Apple's continuous-corner rectangle, as multiples of the
// radius: (distance from the corner along the edge it leaves, distance along
// the edge it reaches).
const corner: [string, ...[number, number][]][] = [
  ["L", [1.52866471, 0]],
  ["C", [1.08849323, 0], [0.86840689, 0], [0.66993427, 0.065496]],
  ["L", [0.63149399, 0.074911]],
  [
    "C",
    [0.37282392, 0.16905899],
    [0.16906013, 0.37282401],
    [0.07491176, 0.63149399],
  ],
  ["C", [0, 0.86840701], [0, 1.08849299], [0, 1.52866483]],
];

// The macOS app icon's shape: a square `width` across at (`at`, `at`) with
// continuous corners. macOS draws a classic icon unframed only when its art
// fills this shape (824 on the 1024 grid, 100 in from each edge).
export function squirclePath(at: number, width: number) {
  const radius = (width * 185.4) / 824;
  const start = at;
  const stop = at + width;
  const corners = [
    ([a, b]: [number, number]) => [stop - a * radius, start + b * radius],
    ([a, b]: [number, number]) => [stop - b * radius, stop - a * radius],
    ([a, b]: [number, number]) => [start + a * radius, stop - b * radius],
    ([a, b]: [number, number]) => [start + b * radius, start + a * radius],
  ];
  let path = `M${points(start + 1.52866483 * radius, start)}`;
  for (const place of corners) {
    for (const [command, ...controls] of corner) {
      path +=
        command + controls.map((point) => points(...place(point))).join(" ");
    }
  }
  return `${path}Z`;
}

// Each image in the icon, its square `width` across at `at`, with the knot
// on it as on any tile. macOS 27 puts a classic icon's own 16 and 32 px
// images in a grey frame, so there are none: it shrinks the 128 px image for
// those sizes instead, whose knot, 4 px to a unit, lands on whole pixels at
// 32 and 16.
export type IconImage = { size: number; at: number; width: number };

export const iconSizes: IconImage[] = [
  { size: 64, at: 6, width: 52 },
  { size: 128, at: 12, width: 104 },
  { size: 256, at: 25, width: 206 },
  { size: 512, at: 50, width: 412 },
  { size: 1024, at: 100, width: 824 },
];

export const carbon = "#222326";
export const white = "#FFFFFF";
export const steel = "#5c5e62";

export function iconSvg({ size, at, width }: IconImage, label: string) {
  const unit = tileKnotUnit(width);
  const knotAt = (size - knotGrid * unit) / 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${label}">`,
    `  <path fill="${carbon}" d="${squirclePath(at, width)}"/>`,
    `  <path fill="${white}" d="${knotPath(unit, knotAt, knotAt)}"/>`,
    `</svg>`,
    "",
  ].join("\n");
}

// The disk image's window, in points: the app and Applications side by side
// at 128 pt, with an arrow from one to the other on White. Finder places
// each icon by its centre, and its title bar takes about 30 pt of the
// window's height, so the icons and their names sit centred in the rest.
export const dmgWindow = { width: 600, height: 400 };
export const dmgIconSize = 128;
export const dmgIcons = {
  app: { x: 170, y: 176 },
  applications: { x: 430, y: 176 },
};

export function dmgBackgroundSvg() {
  const { width, height } = dmgWindow;
  const y = dmgIcons.app.y;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `  <rect width="${width}" height="${height}" fill="${white}"/>`,
    `  <path d="M267 ${y}H333M323 ${y - 9}L333 ${y}L323 ${y + 9}" fill="none" stroke="${steel}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    `</svg>`,
    "",
  ].join("\n");
}
