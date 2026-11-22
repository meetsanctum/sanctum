// Blobs: bytes a driver hands the core, such as a picture of what a media
// player plays, since an app's socket carries only JSON. The core keeps
// each by its SHA-256 and gives clients it at GET /api/blobs/:hash, so a
// device's state names a picture by its hash rather than carrying it.
//
// The core keeps blobs in its memory, never on disk or in a backup: one
// lives while a device's state names it and 10 minutes after, and all of
// them go when the core stops. A driver that names a picture puts it again
// when it starts. Each app keeps at most 16 MB; past that, the core drops
// its oldest that nothing names.

/** The types a blob may be: pictures a browser shows. */
export const blobTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type BlobType = (typeof blobTypes)[number];

/** The largest blob, in bytes, so it crosses the socket in one message. */
export const maxBlobBytes = 700_000;
/** The most an app's blobs come to, in bytes. */
export const maxAppBlobBytes = 16 * 1024 * 1024;
/** How long a blob outlives the last device state that named it, in ms. */
export const blobKeptMs = 10 * 60_000;

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

// How each type's bytes begin, which they must, so nothing is kept as a
// picture that a browser would read as something else.
const startsAs: Record<BlobType, (bytes: Uint8Array) => boolean> = {
  "image/jpeg": (bytes) =>
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) =>
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    ),
  "image/webp": (bytes) =>
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP",
};

/**
 * A blob as it arrived on an app's socket, read as the core keeps it: its
 * type and its bytes, or null for anything the core refuses, such as a type
 * it doesn't keep, bytes over 700 KB or bytes that don't begin as their
 * type does. The core and the test cores refuse alike.
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
  return startsAs[type as BlobType](bytes)
    ? { type: type as BlobType, bytes }
    : null;
}
