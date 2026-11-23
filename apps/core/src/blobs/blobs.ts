import {
  ActionError,
  blobKeptMs,
  maxAppBlobBytes,
  maxAppBlobs,
  type BlobType,
} from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { CoreDatabase } from "../database.js";
import { deviceCapabilities, devices } from "../devices/schema.js";

// Blobs: bytes drivers hand the core, such as a picture of what a media
// player plays, kept by their SHA-256 so a device's state names one by its
// hash and clients fetch it (routes.ts). They live in the core's memory
// only, never on disk or in a backup, so a picture of what someone watched
// doesn't outlast the core. One lives while a device's reported state names
// it and 10 minutes after; a sweep each minute lets the rest go. Each app
// keeps at most 16 MB in at most 128 blobs, and a put past either drops its
// oldest that nothing names, sooner than 10 minutes if it must. An app's go
// when it's removed.

// How often the sweep runs, in ms.
const sweepEveryMs = 60_000;

type Owner = {
  usedAt: number;
  wasNamed: boolean;
};

type Kept = {
  type: BlobType;
  bytes: Uint8Array;
  owners: Map<string, Owner>;
};

export type Blobs = ReturnType<typeof createBlobs>;

export function createBlobs(options: {
  /** The hashes each driver's devices' reported states name now. */
  named: () => ReadonlyMap<string, ReadonlySet<string>>;
  now?: () => Date;
  log: (message: string) => void;
}) {
  const now = () => (options.now?.() ?? new Date()).getTime();
  const kept = new Map<string, Kept>();
  // Each app's blobs, so a put weighs only its own app's.
  const byApp = new Map<string, Map<string, Kept>>();
  let timer: NodeJS.Timeout | undefined;

  function forget(hash: string, blob: Kept, app: string) {
    blob.owners.delete(app);
    if (blob.owners.size === 0) kept.delete(hash);
    const own = byApp.get(app);
    own?.delete(hash);
    if (own?.size === 0) byApp.delete(app);
  }

  function sweep() {
    if (kept.size === 0) return;
    const named = options.named();
    const at = now();
    for (const [hash, blob] of kept) {
      for (const [app, owner] of blob.owners) {
        const isNamed = named.get(app)?.has(hash) ?? false;
        // Start the grace period on the first sweep that sees it go unnamed.
        if (isNamed || owner.wasNamed) owner.usedAt = at;
        owner.wasNamed = isNamed;
        if (at - owner.usedAt >= blobKeptMs) forget(hash, blob, app);
      }
    }
  }

  return {
    /**
     * Keeps an app's blob, already checked (blobOf), and answers its hash.
     * The same bytes give the same hash and share storage, but count for
     * each app that put them. Past an app's 16 MB or 128 blobs, its oldest
     * blobs that none of its devices name go if that makes room for the new
     * one.
     */
    put(app: string, type: BlobType, bytes: Uint8Array): string {
      const hash = createHash("sha256").update(bytes).digest("hex");
      const at = now();
      const known = kept.get(hash);
      const owner = known?.owners.get(app);
      if (owner) {
        owner.usedAt = at;
        return hash;
      }
      const own = [...(byApp.get(app) ?? [])].map(([hash, blob]) => ({
        hash,
        blob,
        usedAt: blob.owners.get(app)!.usedAt,
      }));
      let size = own.reduce(
        (total, { blob }) => total + blob.bytes.length,
        bytes.length,
      );
      let count = own.length + 1;
      const overLimit = () => size > maxAppBlobBytes || count > maxAppBlobs;
      if (overLimit()) {
        const named = options.named().get(app);
        const unnamed = own.filter(({ hash }) => !named?.has(hash));
        const reclaimable = unnamed.reduce(
          (total, { blob }) => total + blob.bytes.length,
          0,
        );
        if (
          size - reclaimable > maxAppBlobBytes ||
          count - unnamed.length > maxAppBlobs
        ) {
          throw new ActionError(
            "conflict",
            "The core keeps 16 MB or 128 of an app's pictures, and its devices name too many to make room",
          );
        }
        unnamed.sort((a, b) => a.usedAt - b.usedAt);
        for (const { hash, blob } of unnamed) {
          forget(hash, blob, app);
          size -= blob.bytes.length;
          count -= 1;
          if (!overLimit()) break;
        }
      }
      const blob = known ?? { type, bytes, owners: new Map<string, Owner>() };
      blob.owners.set(app, { usedAt: at, wasNamed: false });
      kept.set(hash, blob);
      const mine = byApp.get(app) ?? new Map<string, Kept>();
      mine.set(hash, blob);
      byApp.set(app, mine);
      return hash;
    },

    /** A blob by its hash, for a client, or null once it has gone. */
    get(hash: string): { type: BlobType; bytes: Uint8Array } | null {
      const blob = kept.get(hash);
      return blob ? { type: blob.type, bytes: blob.bytes } : null;
    },

    /** An app was removed: what it put goes with it. */
    removeApp(app: string) {
      for (const [hash, blob] of byApp.get(app) ?? []) {
        forget(hash, blob, app);
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
      byApp.clear();
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
  return () => {
    const named = new Map<string, Set<string>>();
    const rows = db
      .select({ driver: devices.driver, observed: deviceCapabilities.observed })
      .from(deviceCapabilities)
      .innerJoin(devices, eq(devices.id, deviceCapabilities.deviceId))
      .where(eq(deviceCapabilities.kind, "media"))
      .all();
    for (const { driver, observed } of rows) {
      const artwork = (observed as { media?: { artwork?: unknown } } | null)
        ?.media?.artwork;
      if (typeof artwork !== "string") continue;
      const hashes = named.get(driver) ?? new Set<string>();
      hashes.add(artwork);
      named.set(driver, hashes);
    }
    return named;
  };
}
