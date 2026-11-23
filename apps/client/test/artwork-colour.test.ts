import { describe, expect, it } from "vitest";

import { artworkColour } from "../src/artwork-colour";

// The veil's colour for a picture: its average, held dark and muted, so
// White text reads on the glass whatever the picture.

const filled = (rgba: [number, number, number, number], count = 4) =>
  new Uint8ClampedArray(Array.from({ length: count }, () => rgba).flat());
const parts = (colour: string | null) =>
  colour!
    .match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/)!
    .slice(1)
    .map(Number);

describe("a picture's colour on the veil", () => {
  it("is a quiet grey for a white cover, at most as light as the veil allows", () => {
    const [lightness, chroma] = parts(
      artworkColour(filled([255, 255, 255, 255])),
    );
    expect(lightness).toBe(0.45);
    expect(chroma).toBeLessThan(0.001);
  });

  it("is a deep colour for a neon one, its strength held", () => {
    const [lightness, chroma, hue] = parts(
      artworkColour(filled([255, 0, 64, 255])),
    );
    expect(lightness).toBe(0.45);
    expect(chroma).toBe(0.12);
    // Still red.
    expect(hue).toBeGreaterThan(0);
    expect(hue).toBeLessThan(40);
  });

  it("is never darker than the veil allows, for a black one", () => {
    const [lightness] = parts(artworkColour(filled([0, 0, 0, 255])));
    expect(lightness).toBe(0.3);
  });

  it("averages in linear light, and leaves out what is see-through", () => {
    const half = new Uint8ClampedArray([
      ...[90, 90, 90, 255],
      ...[0, 0, 0, 255],
      ...[0, 255, 0, 0],
    ]);
    // These two greys average to a lighter grey in linear light. Averaging
    // the encoded channels would hit the lower lightness limit instead.
    const [lightness, chroma] = parts(artworkColour(half));
    expect(lightness).toBeCloseTo(0.371, 2);
    expect(chroma).toBeLessThan(0.001);
    expect(artworkColour(filled([10, 200, 30, 0]))).toBeNull();
  });
});
