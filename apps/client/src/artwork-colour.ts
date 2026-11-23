// The colour of a picture of what plays, for the veil behind it: its pixels
// averaged in linear light, so a bright corner doesn't wash it out, then
// held dark and muted in OKLCH, so White text keeps 4.5:1 on the glass
// whatever the picture. A white cover gives a quiet grey, a neon one a deep
// colour.

// How light and how strong the colour may be (OKLCH lightness and chroma).
const lightness = { min: 0.3, max: 0.45 };
const maxChroma = 0.12;

const toLinear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

// Linear sRGB to OKLab (Björn Ottosson's matrices).
function oklab(r: number, g: number, b: number) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/**
 * The veil's colour for a picture, from its pixels as a canvas gives them
 * (RGBA, 8 bits each): `oklch(L C H)`, or null for a picture with nothing
 * opaque in it.
 */
export function artworkColour(pixels: Uint8ClampedArray): string | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3]! / 255;
    if (alpha === 0) continue;
    r += toLinear(pixels[index]!) * alpha;
    g += toLinear(pixels[index + 1]!) * alpha;
    b += toLinear(pixels[index + 2]!) * alpha;
    weight += alpha;
  }
  if (weight === 0) return null;
  const lab = oklab(r / weight, g / weight, b / weight);
  const chroma = Math.min(Math.hypot(lab.a, lab.b), maxChroma);
  const hue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  const held = Math.min(lightness.max, Math.max(lightness.min, lab.L));
  const round = (value: number, places: number) =>
    Number(value.toFixed(places));
  return `oklch(${round(held, 3)} ${round(chroma, 3)} ${round((hue + 360) % 360, 1)})`;
}
