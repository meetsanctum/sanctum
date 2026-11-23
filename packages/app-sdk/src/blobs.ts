// Blobs: bytes a driver hands the core, such as a picture of what a media
// player plays, since an app's socket carries only JSON. The core keeps
// each by its SHA-256 and gives clients it at GET /api/blobs/:hash, so a
// device's state names a picture by its hash rather than carrying it.
//
// The core keeps blobs in its memory, never on disk or in a backup: one
// lives while a state of one of its own app's devices names it, and a
// minute after; another app's device naming the same bytes keeps nothing.
// All of them go when the core stops. A driver that names a picture puts
// it again when it starts, and whenever it names one its state stopped
// naming. Each app keeps at most 16 MB in at most 128 blobs; past either,
// the core drops its oldest that nothing names, without waiting out the
// minute.
//
// A small file can hold a picture far larger than it looks, which a client
// would have to decode in full to show. So the core reads each picture's
// width and height from its header, decoding nothing, and refuses one over
// 4096 px on either side, or one that moves.

/** The types a blob may be: pictures a browser shows. */
export const blobTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type BlobType = (typeof blobTypes)[number];

/** The largest blob, in bytes, so it crosses the socket in one message. */
export const maxBlobBytes = 700_000;
/** The most an app's blobs come to, in bytes. */
export const maxAppBlobBytes = 16 * 1024 * 1024;
/** The most blobs an app keeps at once. */
export const maxAppBlobs = 128;
/** The widest or tallest picture, in px. */
export const maxBlobSide = 4096;
/** How long an unnamed blob is kept after upload or its last reference, in ms. */
export const blobKeptMs = 60_000;

/** A blob's name: its SHA-256, in lower-case hex. */
export const blobHashPattern = /^[0-9a-f]{64}$/;

/** A blob as an app hands it over (ctx.blobs.put). */
export type AppBlob = { type: BlobType; data: Uint8Array };

/** A blob as it crosses the socket: its bytes in base64. */
export type BlobOnTheWire = { type: BlobType; data: string };

/** What the core answers a put: the blob's name, to put in a device's state. */
export type PutBlob = { hash: string };

const base64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

type PictureSize = { width: number; height: number };

// PNG: the IHDR chunk comes first and gives the size. One with an acTL
// chunk before its pixels is animated (APNG).
function pngSize(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || !signature.every((byte, at) => bytes[at] === byte)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (view.getUint32(8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") return null;
  for (let at = 33; at + 12 <= bytes.length;) {
    const type = ascii(bytes, at + 4, 4);
    const next = at + 12 + view.getUint32(at);
    if (next > bytes.length || type === "acTL" || type === "IEND") return null;
    if (type === "IDAT") {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    at = next;
  }
  return null;
}

// JPEG: the first start-of-frame marker gives the size; the markers before
// it each say how long they are.
function jpegSize(bytes: Uint8Array) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Markers that stand alone, with no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // The scan begins, or the picture ends, before any frame.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = view.getUint16(at + 2);
    const next = at + 2 + length;
    if (length < 2 || next > bytes.length) return null;
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      // Eight fixed bytes, then three per component, including at least one.
      if (length < 11 || length !== 8 + 3 * bytes[at + 9]!) return null;
      return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
    }
    at = next;
  }
  return null;
}

function webpFrameSize(
  view: DataView,
  type: string,
  at: number,
  length: number,
) {
  if (type === "VP8 ") {
    if (
      length < 10 ||
      (view.getUint8(at) & 1) !== 0 ||
      view.getUint16(at + 3) !== 0x9d01 ||
      view.getUint8(at + 5) !== 0x2a
    ) {
      return null;
    }
    return {
      width: view.getUint16(at + 6, true) & 0x3fff,
      height: view.getUint16(at + 8, true) & 0x3fff,
    };
  }
  if (length < 5 || view.getUint8(at) !== 0x2f) return null;
  const bits = view.getUint32(at + 1, true);
  if (bits >>> 29) return null;
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

// A still WebP contains one VP8 or VP8L frame. With an extended header
// (VP8X), check that the frame has the same size as the canvas.
function webpSize(bytes: Uint8Array) {
  if (
    bytes.length < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const end = 8 + view.getUint32(4, true);
  if (end > bytes.length || end % 2 !== 0) return null;
  let canvas: PictureSize | undefined;
  let frame: PictureSize | null = null;
  let at = 12;
  while (at + 8 <= end) {
    const type = ascii(bytes, at, 4);
    const length = view.getUint32(at + 4, true);
    const data = at + 8;
    const next = data + length + (length % 2);
    if (next > end || type === "ANIM" || type === "ANMF") return null;
    if (type === "VP8X") {
      if (at !== 12 || length !== 10 || (bytes[data]! & 0x02) !== 0) {
        return null;
      }
      canvas = {
        width: (view.getUint32(data + 3, true) >>> 8) + 1,
        height: (view.getUint32(data + 6, true) >>> 8) + 1,
      };
    } else if (type === "VP8 " || type === "VP8L") {
      if (frame || (!canvas && at !== 12)) return null;
      frame = webpFrameSize(view, type, data, length);
      if (!frame) return null;
    }
    at = next;
  }
  if (at !== end || !frame) return null;
  if (
    canvas &&
    (canvas.width !== frame.width || canvas.height !== frame.height)
  ) {
    return null;
  }
  return frame;
}

/**
 * A picture's width and height from its header, decoding nothing; null when
 * the header can't be read, or the picture moves.
 */
export function pictureSize(
  type: BlobType,
  bytes: Uint8Array,
): PictureSize | null {
  switch (type) {
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/png":
      return pngSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    default:
      return null;
  }
}

/** Whether a picture of this size is one the core keeps. */
export function fitsPictureBudget(size: PictureSize) {
  return (
    size.width > 0 &&
    size.height > 0 &&
    size.width <= maxBlobSide &&
    size.height <= maxBlobSide
  );
}

/**
 * A blob as it arrived on an app's socket, read as the core keeps it: its
 * type and its bytes, or null for anything the core refuses, such as a type
 * it doesn't keep, bytes over 700 KB, bytes that don't begin as their type
 * does, or a picture whose header gives no size, a side over 4096 px, or
 * says it moves. The core and the test cores refuse alike.
 */
export function blobOf(
  blob: unknown,
): { type: BlobType; bytes: Uint8Array } | null {
  if (typeof blob !== "object" || blob === null) return null;
  const { type, data } = blob as Record<string, unknown>;
  if (!blobTypes.includes(type as BlobType)) return null;
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    data.length > Math.ceil(maxBlobBytes / 3) * 4 ||
    !base64.test(data)
  )
    return null;
  const bytes = Uint8Array.from(Buffer.from(data, "base64"));
  if (bytes.length === 0 || bytes.length > maxBlobBytes) return null;
  const size = pictureSize(type as BlobType, bytes);
  return size && fitsPictureBudget(size)
    ? { type: type as BlobType, bytes }
    : null;
}
