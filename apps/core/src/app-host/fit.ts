import {
  appApiVersion,
  type AppShortfall,
  type StaticManifest,
} from "@meetsanctum/app-sdk";
import semver from "semver";

import { lowMemoryShare } from "../system/status.js";

// Whether an app fits this home before it's added: the app API its manifest
// targets, the kit its pages were built for, the memory its container gets
// and the image its data lives on. Each shortfall says what's short, so the
// sheet can say what would help before anything changes. What isn't known,
// as on a host that doesn't say its memory, holds nothing back: the manager
// still refuses an image it has no room for.

const mebibyte = 1024 * 1024;
// What an update needs free, which the manager keeps whatever an app's image
// asks for, and Settings → Status warns under.
const keptForUpdates = 1536 * mebibyte;

/** Whether this core serves the app API the manifest targets. */
export function servesAppApi(manifest: Pick<StaticManifest, "core">) {
  return (
    semver.validRange(manifest.core) !== null &&
    semver.satisfies(appApiVersion, manifest.core)
  );
}

/** What the host has, as the manager says. */
export type HostRoom = {
  memory: { total: number; available: number } | null;
  storage: {
    free: number;
    // Each app's image: what it may grow to, and what it takes now.
    images?: { state: string; sizeMb: number; bytes: number }[];
  } | null;
};

export function shortfallsOf(
  manifest: Pick<StaticManifest, "core" | "runtime">,
  options: {
    // What its pages need of the kit, if they don't fit it.
    pagesNeed: "sanctum" | "pages" | null;
    host: HostRoom | null;
  },
): AppShortfall[] {
  const shortfalls: AppShortfall[] = [];
  if (!servesAppApi(manifest)) {
    shortfalls.push({ kind: "sanctum", range: manifest.core });
  }
  if (options.pagesNeed) {
    shortfalls.push({ kind: "pages", needs: options.pagesNeed });
  }
  const memory = options.host?.memory;
  if (memory) {
    const needs = manifest.runtime.memory * mebibyte;
    // What's left once it runs stays above what Status warns under.
    const free = Math.max(0, memory.available - memory.total * lowMemoryShare);
    if (needs > free) shortfalls.push({ kind: "memory", needs, free });
  }
  const storage = options.host?.storage;
  if (storage) {
    const needs = manifest.runtime.data * mebibyte;
    // The images the home has may each still grow to their size.
    const promised = (storage.images ?? [])
      .filter((image) => image.state !== "damaged")
      .reduce(
        (sum, image) =>
          sum + Math.max(0, image.sizeMb * mebibyte - image.bytes),
        0,
      );
    const free = Math.max(0, storage.free - promised - keptForUpdates);
    if (needs > free) shortfalls.push({ kind: "space", needs, free });
  }
  return shortfalls;
}
