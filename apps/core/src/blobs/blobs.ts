import {
  ActionError,
  blobKeptMs,
  maxAppBlobBytes,
  maxAppBlobs,
  type BlobType,
  type DeviceInfo,
} from "@meetsanctum/app-sdk";
import { createHash } from "node:crypto";

import type { DeviceChange } from "../devices/devices.js";

// Blobs: bytes drivers hand the core, such as a picture of what a media
// player plays, kept by their SHA-256 so a device's state names one by its
// hash and clients fetch it (routes.ts). They live in the core's memory
// only, never on disk or in a backup, so a picture of what someone watched
// doesn't outlast the core. One lives while a device's reported state names
// it and a minute after: long enough for a driver to put a picture before
// the report that names it, and for a client to fetch one it has just seen
// named. The core tracks which pictures each device names in memory,
// starting with the devices in the home and following their changes.
// Each app keeps at most 16 MB in at most 128 blobs, and a put past either
// drops its oldest that nothing names, sooner than a minute if it must.
// An app's go when it's removed.

// How often the sweep runs, in ms.
const sweepEveryMs = 15_000;

type Kept = {
  type: BlobType;
  bytes: Uint8Array;
  // For each owner, when it put the picture or last stopped naming it.
  usedAtByApp: Map<string, number>;
};

/** The pictures a device's media capabilities name, once per device. */
function artworkOf(device: DeviceInfo | null) {
  if (!device) return null;
  let hashes: Set<string> | undefined;
  for (const capability of device.capabilities) {
    if (capability.kind !== "media") continue;
    const artwork = capability.observed?.media?.artwork;
    if (typeof artwork === "string") {
      (hashes ??= new Set()).add(artwork);
    }
  }
  return hashes ? { app: device.driver, hashes } : null;
}

export type Blobs = ReturnType<typeof createBlobs>;

export function createBlobs(options: {
  /** For tests: the core's clock. */
  now?: () => Date;
  log: (message: string) => void;
}) {
  // The minute is measured on a clock that only moves forward, so a host
  // whose time jumps, as a Pi's does when it first syncs, keeps a picture
  // its full minute.
  const now = options.now
    ? () => options.now!().getTime()
    : () => performance.now();
  const kept = new Map<string, Kept>();
  // Each app's blobs, so a put weighs only its own app's.
  const byApp = new Map<string, Map<string, Kept>>();
  // The pictures each device names, and how many of each app's devices
  // name each of its pictures.
  const names = new Map<string, NonNullable<ReturnType<typeof artworkOf>>>();
  const namedBy = new Map<string, Map<string, number>>();
  let timer: NodeJS.Timeout | undefined;

  const isNamed = (app: string, hash: string) =>
    namedBy.get(app)?.has(hash) ?? false;

  function updateArtwork(id: string, device: DeviceInfo | null) {
    const before = names.get(id);
    const after = artworkOf(device);
    const isSameApp = before?.app === after?.app;
    if (before) {
      const counts = namedBy.get(before.app)!;
      for (const hash of before.hashes) {
        if (isSameApp && after?.hashes.has(hash)) continue;
        const count = counts.get(hash)! - 1;
        if (count > 0) counts.set(hash, count);
        else {
          counts.delete(hash);
          // Its minute starts now.
          byApp.get(before.app)?.get(hash)?.usedAtByApp.set(before.app, now());
        }
      }
      if (counts.size === 0) namedBy.delete(before.app);
    }
    if (after) {
      const counts = namedBy.get(after.app) ?? new Map<string, number>();
      for (const hash of after.hashes) {
        if (isSameApp && before?.hashes.has(hash)) continue;
        counts.set(hash, (counts.get(hash) ?? 0) + 1);
      }
      namedBy.set(after.app, counts);
      names.set(id, after);
    } else {
      names.delete(id);
    }
  }

  function forget(hash: string, blob: Kept, app: string) {
    blob.usedAtByApp.delete(app);
    if (blob.usedAtByApp.size === 0) kept.delete(hash);
    const own = byApp.get(app);
    own?.delete(hash);
    if (own?.size === 0) byApp.delete(app);
  }

  function sweep() {
    const at = now();
    for (const [hash, blob] of kept) {
      for (const [app, usedAt] of blob.usedAtByApp) {
        if (!isNamed(app, hash) && at - usedAt >= blobKeptMs) {
          forget(hash, blob, app);
        }
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
      if (known?.usedAtByApp.has(app)) {
        known.usedAtByApp.set(app, at);
        return hash;
      }
      const own = [...(byApp.get(app) ?? [])].map(([hash, blob]) => ({
        hash,
        blob,
        usedAt: blob.usedAtByApp.get(app)!,
      }));
      let size = own.reduce(
        (total, { blob }) => total + blob.bytes.length,
        bytes.length,
      );
      let count = own.length + 1;
      const overLimit = () => size > maxAppBlobBytes || count > maxAppBlobs;
      if (overLimit()) {
        const unnamed = own.filter(({ hash }) => !isNamed(app, hash));
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
      const blob = known ?? {
        type,
        bytes,
        usedAtByApp: new Map<string, number>(),
      };
      blob.usedAtByApp.set(app, at);
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

    /** A device changed or became visible or hidden. */
    deviceChanged({ id, after }: DeviceChange) {
      updateArtwork(id, after);
    },

    /** An app was removed: what it put goes with it. */
    removeApp(app: string) {
      for (const [hash, blob] of byApp.get(app) ?? []) {
        forget(hash, blob, app);
      }
    },

    /**
     * Starts the sweep, as a step of starting, from the devices as they are
     * then: what changes after comes as events.
     */
    start(devices: readonly DeviceInfo[]) {
      for (const device of devices) updateArtwork(device.id, device);
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
      names.clear();
      namedBy.clear();
    },

    /** Runs the sweep now, as its timer would. */
    sweep,
  };
}
