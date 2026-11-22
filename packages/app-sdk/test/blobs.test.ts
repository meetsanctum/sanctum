import { describe, expect, it } from "vitest";

import { blobOf, maxBlobBytes } from "../src/index.js";

// What the core keeps of a blob an app hands over: a picture of its
// declared type, of up to 700 KB, its bytes in base64.

const wire = (type: string, bytes: number[] | Uint8Array) => ({
  type,
  data: Buffer.from(Uint8Array.from(bytes)).toString("base64"),
});
const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1];
const jpeg = [0xff, 0xd8, 0xff, 0xe0, 1];
const webp = [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), 1];

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
});
