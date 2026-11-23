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
// named. Which device names which picture is followed in memory, from the
// devices as the core starts and each change after (modules.ts), so nothing
// is looked up to decide. Each app keeps at most 16 MB in at most 128
// blobs, and a put past either drops its oldest that nothing names, sooner
// than a minute if it must. An app's go when it's removed.

// How often the sweep runs, in ms.
const sweepEveryMs = 15_000;

type Owner = {
  // When it was put, or last stopped being named.
  usedAt: number;
};

type Kept = {
  type: BlobType;
  bytes: Uint8Array;
  owners: Map<string, Owner>;
};

/** The picture a device's reported state names, and the app that brings it. */
function artworkOf(device: DeviceInfo | null) {
  if (!device) return null;
  for (const capability of device.capabilities) {
    if (capability.kind !== "media") continue;
    const artwork = capability.observed?.media?.artwork;
    if (typeof artwork === "string") {
      return { app: device.driver, hash: artwork };
    }
  }
  return null;
}

export type Blobs = ReturnType<typeof createBlobs>;

export function createBlobs(options: {
  now?: () => Date;
  log: (message: string) => void;
}) {
  const now = () => (options.now?.() ?? new Date()).getTime();
  const kept = new Map<string, Kept>();
  // Each app's blobs, so a put weighs only its own app's.
  const byApp = new Map<string, Map<string, Kept>>();
  // The picture each device names, and how many of each app's devices
  // name each of its pictures.
  const names = new Map<string, { app: string; hash: string }>();
  const namedBy = new Map<string, Map<string, number>>();
  let timer: NodeJS.Timeout | undefined;

  const isNamed = (app: string, hash: string) =>
    (namedBy.get(app)?.get(hash) ?? 0) > 0;

  function name(id: string, named: { app: string; hash: string } | null) {
    const before = names.get(id);
    if (before?.app === named?.app && before?.hash === named?.hash) return;
    if (before) {
      const counts = namedBy.get(before.app)!;
      const count = counts.get(before.hash)! - 1;
      if (count > 0) counts.set(before.hash, count);
      else {
        counts.delete(before.hash);
        if (counts.size === 0) namedBy.delete(before.app);
        // Its minute starts now.
        const owner = kept.get(before.hash)?.owners.get(before.app);
        if (owner) owner.usedAt = now();
      }
      names.delete(id);
    }
    if (named) {
      names.set(id, named);
      const counts = namedBy.get(named.app) ?? new Map<string, number>();
      counts.set(named.hash, (counts.get(named.hash) ?? 0) + 1);
      namedBy.set(named.app, counts);
    }
  }

  function forget(hash: string, blob: Kept, app: string) {
    blob.owners.delete(app);
    if (blob.owners.size === 0) kept.delete(hash);
    const own = byApp.get(app);
    own?.delete(hash);
    if (own?.size === 0) byApp.delete(app);
  }

  function sweep() {
    const at = now();
    for (const [hash, blob] of kept) {
      for (const [app, owner] of blob.owners) {
        if (!isNamed(app, hash) && at - owner.usedAt >= blobKeptMs) {
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
      const blob = known ?? { type, bytes, owners: new Map<string, Owner>() };
      blob.owners.set(app, { usedAt: at });
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

    /** A device changed, was added or was removed (the event bus). */
    deviceChanged({ id, after }: DeviceChange) {
      name(id, artworkOf(after));
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
      for (const device of devices) name(device.id, artworkOf(device));
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
