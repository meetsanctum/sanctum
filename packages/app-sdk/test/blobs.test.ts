import { describe, expect, it } from "vitest";

import { blobOf, maxBlobBytes, pictureSize } from "../src/index.js";

// What the core keeps of a blob an app hands over: a still picture of its
// declared type, of up to 700 KB, its bytes in base64, whose header gives a
// size of up to 4096 px a side and 16 megapixels.

const wire = (type: string, bytes: number[] | Uint8Array) => ({
  type,
  data: Buffer.from(Uint8Array.from(bytes)).toString("base64"),
});
const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const le16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const le24 = (value: number) => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
];
const chunk = (type: string, data: number[]) => [
  ...u32(data.length),
  ...Buffer.from(type),
  ...data,
  0,
  0,
  0,
  0,
];
const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngOf = (width: number, height: number, ...chunks: number[][]) => [
  ...signature,
  ...chunk("IHDR", [...u32(width), ...u32(height), 8, 2, 0, 0, 0]),
  ...chunks.flat(),
  ...chunk("IDAT", [1]),
];
// A JPEG with an APP0 segment before its frame, as most have.
const jpegOf = (width: number, height: number) => [
  0xff,
  0xd8,
  0xff,
  0xe0,
  0,
  4,
  0x4a,
  0x46,
  0xff,
  0xc0,
  0,
  11,
  8,
  (height >> 8) & 0xff,
  height & 0xff,
  (width >> 8) & 0xff,
  width & 0xff,
  1,
  1,
  0x11,
  0,
];
const riff = (body: number[]) => [
  ...Buffer.from("RIFF"),
  ...le24(body.length + 4),
  0,
  ...Buffer.from("WEBP"),
  ...body,
];
const lossy = (width: number, height: number) =>
  riff([
    ...Buffer.from("VP8 "),
    ...u32(0),
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    ...le16(width),
    ...le16(height),
    0,
    0,
  ]);
const lossless = (width: number, height: number) => {
  const bits = (width - 1) | ((height - 1) << 14);
  return riff([
    ...Buffer.from("VP8L"),
    ...u32(0),
    0x2f,
    bits & 0xff,
    (bits >>> 8) & 0xff,
    (bits >>> 16) & 0xff,
    (bits >>> 24) & 0xff,
    0,
    0,
    0,
    0,
    0,
  ]);
};
const extended = (width: number, height: number, flags = 0) =>
  riff([
    ...Buffer.from("VP8X"),
    ...u32(10),
    flags,
    0,
    0,
    0,
    ...le24(width - 1),
    ...le24(height - 1),
    0,
    0,
  ]);
const png = pngOf(1, 1);
const jpeg = jpegOf(1, 1);
const webp = lossy(1, 1);

describe("a blob an app hands over", () => {
  it("is a JPEG, PNG or WebP whose bytes begin as its type's do", () => {
    expect(blobOf(wire("image/png", png))).toEqual({
      type: "image/png",
      bytes: Uint8Array.from(png),
    });
    expect(blobOf(wire("image/jpeg", jpeg))?.type).toBe("image/jpeg");
    expect(blobOf(wire("image/webp", webp))?.type).toBe("image/webp");
  });

  it("is refused as another type, or as one the core doesn't keep", () => {
    expect(blobOf(wire("image/jpeg", png))).toBeNull();
    expect(blobOf(wire("image/svg+xml", [0x3c, 0x73]))).toBeNull();
    expect(blobOf(wire("text/html", png))).toBeNull();
  });

  it("is refused when it isn't base64, is empty, or is over 700 KB", () => {
    expect(blobOf({ type: "image/png", data: "not base64!" })).toBeNull();
    expect(blobOf({ type: "image/png", data: "" })).toBeNull();
    expect(blobOf(null)).toBeNull();
    const large = new Uint8Array(maxBlobBytes + 1);
    large.set(png);
    expect(blobOf(wire("image/png", large))).toBeNull();
    const fits = new Uint8Array(maxBlobBytes);
    fits.set(png);
    expect(blobOf(wire("image/png", fits))?.bytes.length).toBe(maxBlobBytes);
  });

  it("is a picture of up to 4096 px a side and 16 megapixels, read from its header", () => {
    expect(pictureSize("image/png", Uint8Array.from(pngOf(640, 360)))).toEqual({
      width: 640,
      height: 360,
    });
    expect(
      pictureSize("image/jpeg", Uint8Array.from(jpegOf(1500, 1000))),
    ).toEqual({ width: 1500, height: 1000 });
    expect(pictureSize("image/webp", Uint8Array.from(lossy(300, 200)))).toEqual(
      { width: 300, height: 200 },
    );
    expect(
      pictureSize("image/webp", Uint8Array.from(lossless(300, 200))),
    ).toEqual({ width: 300, height: 200 });
    expect(
      pictureSize("image/webp", Uint8Array.from(extended(3000, 2000))),
    ).toEqual({ width: 3000, height: 2000 });

    expect(blobOf(wire("image/png", pngOf(4096, 4096)))).not.toBeNull();
    expect(blobOf(wire("image/jpeg", jpegOf(4096, 2304)))).not.toBeNull();
    expect(blobOf(wire("image/png", pngOf(4097, 100)))).toBeNull();
    expect(blobOf(wire("image/jpeg", jpegOf(100, 30_000)))).toBeNull();
    expect(blobOf(wire("image/webp", extended(16_384, 16_384)))).toBeNull();
    expect(blobOf(wire("image/png", pngOf(0, 100)))).toBeNull();
  });

  it("is refused when it moves, or its header gives no size", () => {
    expect(
      blobOf(wire("image/png", pngOf(10, 10, chunk("acTL", u32(2))))),
    ).toBeNull();
    expect(blobOf(wire("image/webp", extended(10, 10, 0x02)))).toBeNull();
    // Only the signature, as a file cut short would be.
    expect(blobOf(wire("image/png", signature))).toBeNull();
    expect(blobOf(wire("image/jpeg", [0xff, 0xd8, 0xff, 0xda]))).toBeNull();
    expect(
      blobOf(wire("image/webp", riff([...Buffer.from("ALPH"), 0, 0, 0, 0]))),
    ).toBeNull();
  });
});
