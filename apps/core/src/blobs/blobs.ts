import {
  ActionError,
  blobKeptMs,
  maxAppBlobBytes,
  type BlobType,
} from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { CoreDatabase } from "../database.js";
import { deviceCapabilities } from "../devices/schema.js";

// Blobs: bytes drivers hand the core, such as a picture of what a media
// player plays, kept by their SHA-256 so a device's state names one by its
// hash and clients fetch it (routes.ts). They live in the core's memory
// only, never on disk or in a backup, so a picture of what someone watched
// doesn't outlast the core. One lives while a device's reported state names
// it and 10 minutes after; a sweep each minute lets the rest go. Each app
// keeps at most 16 MB, and a put past that drops its oldest that nothing
// names. An app's go when it's removed.

// How often the sweep runs, in ms.
const sweepEveryMs = 60_000;

type Kept = {
  app: string;
  type: BlobType;
  bytes: Uint8Array;
  // When a device's state last named it, or it was put.
  namedAt: number;
};

export type Blobs = ReturnType<typeof createBlobs>;

export function createBlobs(options: {
  /** The hashes the devices' reported states name now. */
  named: () => ReadonlySet<string>;
  now?: () => Date;
  log: (message: string) => void;
}) {
  const now = () => (options.now?.() ?? new Date()).getTime();
  const kept = new Map<string, Kept>();
  let timer: NodeJS.Timeout | undefined;

  const sizeOf = (app: string) =>
    [...kept.values()]
      .filter((each) => each.app === app)
      .reduce((total, each) => total + each.bytes.length, 0);

  function sweep() {
    const named = options.named();
    const at = now();
    for (const [hash, blob] of kept) {
      if (named.has(hash)) blob.namedAt = at;
      else if (at - blob.namedAt > blobKeptMs) kept.delete(hash);
    }
  }

  return {
    /**
     * Keeps an app's blob, already checked (blobOf), and answers its hash.
     * The same bytes give the same hash, kept once, by the app that first
     * put them. Past an app's 16 MB, its oldest blobs that nothing names
     * go; if those don't make room, the put is refused.
     */
    put(app: string, type: BlobType, bytes: Uint8Array): string {
      const hash = createHash("sha256").update(bytes).digest("hex");
      const at = now();
      const known = kept.get(hash);
      if (known) {
        known.namedAt = at;
        return hash;
      }
      let size = sizeOf(app) + bytes.length;
      if (size > maxAppBlobBytes) {
        const named = options.named();
        const unnamed = [...kept]
          .filter(([each, blob]) => blob.app === app && !named.has(each))
          .sort(([, a], [, b]) => a.namedAt - b.namedAt);
        for (const [each, blob] of unnamed) {
          if (size <= maxAppBlobBytes) break;
          kept.delete(each);
          size -= blob.bytes.length;
        }
        if (size > maxAppBlobBytes) {
          throw new ActionError(
            "conflict",
            "The core keeps 16 MB of an app's pictures, and its devices name them all",
          );
        }
      }
      kept.set(hash, { app, type, bytes, namedAt: at });
      return hash;
    },

    /** A blob by its hash, for a client, or null once it has gone. */
    get(hash: string): { type: BlobType; bytes: Uint8Array } | null {
      const blob = kept.get(hash);
      return blob ? { type: blob.type, bytes: blob.bytes } : null;
    },

    /** An app was removed: what it put goes with it. */
    removeApp(app: string) {
      for (const [hash, blob] of kept) {
        if (blob.app === app) kept.delete(hash);
      }
    },

    /** Starts the sweep, as a step of starting. */
    start() {
      timer = setInterval(() => {
        try {
          sweep();
        } catch (error) {
          options.log(`blobs: the sweep failed (${String(error)})`);
        }
      }, sweepEveryMs);
      timer.unref();
    },

    /** Stops the sweep and lets every blob go, as a step of stopping. */
    close() {
      clearInterval(timer);
      timer = undefined;
      kept.clear();
    },

    /** Runs the sweep now, as its timer would. */
    sweep,
  };
}

/**
 * The pictures the devices' reported states name now: each media player's
 * `media.artwork`.
 */
export function namedArtwork(db: CoreDatabase) {
  return (): ReadonlySet<string> => {
    const named = new Set<string>();
    const rows = db
      .select({ observed: deviceCapabilities.observed })
      .from(deviceCapabilities)
      .where(eq(deviceCapabilities.kind, "media"))
      .all();
    for (const { observed } of rows) {
      const artwork = (observed as { media?: { artwork?: unknown } } | null)
        ?.media?.artwork;
      if (typeof artwork === "string") named.add(artwork);
    }
    return named;
  };
}
